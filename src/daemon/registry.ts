import { EventEmitter } from "node:events";
import { mkdir, access } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { loadConfig } from "./config.js";
import { createServer, type SessionRegistryLike } from "./server.js";
import { createWorktree, currentBranch, excludeBenchDir, inspectWorktree, removeWorktree } from "./worktree.js";
import { bootstrapWorktree, BootstrapError } from "./bootstrap.js";
import { ClaudeSession } from "./claude-session.js";
import { existsSync } from "node:fs";
import { latestReportSeq, findReport, latestTurn } from "./reports.js";
import { SessionStore } from "./store.js";
import { appendActivity } from "./activity.js";
import { resolveTurnOutcome } from "./turn-outcome.js";
import { appendEntry, readThread } from "./thread.js";
import { answeredReportSeq } from "./answered.js";
import { asRole } from "../shared/roles.js";
import { houseRules, readSettings, writeSettings, NO_SETTINGS, type Settings } from "./settings.js";
import type { RosterRow, SessionStatus } from "../shared/types.js";

interface Entry {
  row: RosterRow;
  reportsDir: string;
  threadPath: string;
  session: ClaudeSession | null;
  alive: boolean;
  /** Enough to bring the specialist back after the daemon has restarted. */
  worktree: string;
  branch: string;
  /** False when the specialist works in the project checkout itself. */
  isolated: boolean;
  /** Whether the CLI has a conversation to resume. See SessionRecord. */
  resumable: boolean;
  /** Turns already taken, read from disk when the roster is restored. */
  turnsTaken: number;
  /** The developer ended this turn, so the exit is a decision not a crash. */
  stopping?: boolean;
  model: string;
  port: number;
}

export class SessionRegistry extends EventEmitter implements SessionRegistryLike {
  private entries = new Map<string, Entry>();
  private readonly store: SessionStore;
  /**
   * Held in memory as well as on disk because the framing is built
   * synchronously, at the instant a turn starts. Saving updates both, so a
   * rule written now is in the next turn of every specialist, including the
   * ones already running.
   */
  private settings: Settings = NO_SETTINGS;

  constructor(private readonly config: ReturnType<typeof loadConfig>) {
    super();
    this.store = new SessionStore(config.home);
  }

  getSettings(): Settings {
    return this.settings;
  }

  async saveSettings(input: unknown): Promise<Settings> {
    this.settings = await writeSettings(this.config.home, input);
    return this.settings;
  }

  /**
   * Rebuild the roster from disk. Nothing is spawned: a specialist costs
   * nothing until it is prompted, and the developer may only want to read
   * what an old one already wrote.
   */
  async restore(): Promise<void> {
    this.settings = await readSettings(this.config.home);

    for (const rec of await this.store.all()) {
      const worktreeGone = !existsSync(rec.worktree);
      // Read once and used twice: what has already been answered, and whether
      // this specialist has ever spoken.
      const thread = await readThread(join(rec.reportsDir, "thread.jsonl"));
      this.entries.set(rec.id, {
        reportsDir: rec.reportsDir,
        threadPath: join(rec.reportsDir, "thread.jsonl"),
        session: null,
        alive: false,
        worktree: rec.worktree,
        turnsTaken: await latestTurn(rec.reportsDir),
        // Records written before branches carried the session id named the
        // branch after the label.
        branch: rec.branch ?? `worktree-${rec.label}`,
        // Absent on every record written before the toggle existed, and all
        // of those had a worktree.
        isolated: rec.isolated ?? true,
        // Absent on records written before this was tracked. Rather than
        // guess, read it off the thread: a specialist with entries has taken
        // turns, and a turn is exactly what leaves the CLI a conversation to
        // resume. Guessing false is safe for the process and expensive for
        // the developer - it silently drops everything the specialist knows.
        resumable: rec.resumable ?? thread.length > 0,
        model: rec.model,
        port: rec.port,
        row: {
          id: rec.id,
          label: rec.label,
          role: asRole(rec.role),
          project: rec.project,
          status: worktreeGone ? "crashed" : "awaiting_decision",
          detail: worktreeGone ? "worktree is gone" : "ready",
          latestReportSeq: await latestReportSeq(rec.reportsDir),
          // Derived from the thread rather than stored: the conversation
          // already records who spoke last, so it cannot drift.
          answeredReportSeq: answeredReportSeq(thread),
          startedAt: null,
          tokens: 0,
          activity: [],
        },
      });
    }
    this.emit("roster");
  }

  list(): RosterRow[] {
    return [...this.entries.values()].map((e) => e.row);
  }

  get(id: string): { reportsDir: string; threadPath: string; alive: boolean; revivable: boolean } | null {
    const entry = this.entries.get(id);
    if (!entry) return null;
    return {
      reportsDir: entry.reportsDir,
      threadPath: entry.threadPath,
      alive: entry.alive,
      // Restored from disk with no process yet. Cold is not dead: prompting
      // it brings it back, so it must not be refused like a crashed one.
      revivable: !entry.alive && entry.worktree !== "" && existsSync(entry.worktree),
    };
  }

  private update(id: string, status: SessionStatus, detail: string): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    entry.row.status = status;
    entry.row.detail = detail;
    this.emit("roster");
  }

  /**
   * Wire a process to a roster row. Creating a specialist and reviving one
   * after a restart differ only in whether the CLI is resuming a transcript,
   * so they share this.
   */
  private attach(id: string, opts: {
    label: string;
    worktree: string;
    model: string;
    port: number;
    resume?: boolean;
    startTurn?: number;
  }): ClaudeSession {
    const entry = this.entries.get(id)!;
    const reportsDir = entry.reportsDir;

    const session = new ClaudeSession({
      id,
      label: opts.label,
      worktree: opts.worktree,
      reportsDir,
      hookCommand: this.config.hookCommand,
      pluginDir: this.config.pluginDir,
      model: opts.model,
      port: opts.port,
      resume: opts.resume,
      cockpitUrl: `http://127.0.0.1:${this.config.port}`,
      claudeBin: this.config.claudeBin,
      startTurn: opts.startTurn,
      rules: () => houseRules(this.settings),
    });

    const syncProgress = () => {
      const entry = this.entries.get(id);
      if (!entry) return;
      entry.row.startedAt = session.turnStartedAt;
      entry.row.tokens = session.turnTokens;
    };

    let progressPending = false;
    session.on("progress", () => {
      syncProgress();
      // At most one roster broadcast a second: the estimate updates far
      // faster than anyone can read it.
      if (progressPending) return;
      progressPending = true;
      setTimeout(() => { progressPending = false; this.emit("roster"); }, 1000).unref?.();
    });

    session.on("activity", (line: string) => {
      syncProgress();
      const current = this.entries.get(id);
      if (current) {
        // A trail, not a single line: one tool name tells you what is
        // happening this instant, never where the turn has got to.
        current.row.activity = appendActivity(current.row.activity, line, new Date().toISOString());
      }
      this.update(id, "working", line);
    });
    session.on("exit", (code: number | null, stderr: string) => {
      const entry = this.entries.get(id);
      if (entry) entry.alive = false;

      // Asked for, not suffered. The specialist is still here and its next
      // prompt revives it from the last turn it finished.
      if (entry?.stopping) {
        entry.stopping = false;
        this.update(id, "awaiting_decision", "stopped by you");
        return;
      }

      // The CLI's own words first: it refuses with a plain sentence, and that
      // sentence is the difference between a developer who knows what to do
      // and one looking at "process exited".
      const said = (stderr ?? "").split("\n").filter((l) => l.trim() !== "").pop();
      this.update(id, "crashed", said ?? (code === null ? "process exited" : `process exited (${code})`));
    });

    session.on("reply", async (text: string) => {
      // Whatever the specialist said out loud. If it also wrote a report,
      // that card is appended separately when the turn ends.
      const entry = this.entries.get(id);
      if (!entry) return;

      // Where the answer had shape worth rendering, the specialist wrote a
      // page too. The prose becomes the card's one-line summary.
      const seq = session.turn;
      const hasArtifact = await access(join(reportsDir, String(seq), "reply.html"))
        .then(() => true)
        .catch(() => false);

      await appendEntry(entry.threadPath, {
        kind: "reply",
        body: text,
        ...(hasArtifact ? { replySeq: seq } : {}),
      });
      this.emit("roster");
    });

    session.on("turn-end", async (result: { is_error?: boolean; subtype?: string }) => {
      const entry = this.entries.get(id);
      if (!entry) return;

      const seq = await latestReportSeq(reportsDir);
      const hasNewReport = seq !== null && seq !== entry.row.latestReportSeq;
      entry.row.latestReportSeq = seq;

      if (hasNewReport) {
        const report = await findReport(reportsDir, seq);
        await appendEntry(entry.threadPath, {
          kind: "report",
          body: report ? report.decision.title : `Report ${seq}`,
          reportSeq: seq,
        });
      }

      // A turn has ended, so the CLI has written a conversation and the next
      // process can pick it up.
      if (!entry.resumable) {
        entry.resumable = true;
        void this.store.markResumable(id);
      }

      syncProgress();
      const outcome = resolveTurnOutcome({
        isError: result?.is_error === true,
        subtype: result?.subtype ?? "unknown",
        hasNewReport,
      });
      this.update(id, outcome.status, outcome.detail);
    });

    entry.session = session;
    entry.alive = true;
    session.open();
    return session;
  }

  async create(input: {
    project: string;
    label: string;
    model: string;
    /** What kind of agent this is. Anything unrecognised is a specialist. */
    role?: string;
    /** Default true: isolation is what a specialist is normally for. */
    isolated?: boolean;
  }): Promise<string> {
    const isolated = input.isolated ?? true;
    const role = asRole(input.role);
    const id = randomUUID();
    const reportsDir = join(input.project, ".bench", "reports", id);

    this.entries.set(id, {
      reportsDir,
      threadPath: join(reportsDir, "thread.jsonl"),
      session: null,
      alive: false,
      worktree: "",
      branch: "",
      isolated,
      resumable: false,
      turnsTaken: 0,
      model: input.model,
      port: 0,
      row: {
        id,
        label: input.label,
        role,
        project: input.project,
        status: "provisioning",
        detail: isolated ? "creating worktree" : "opening the checkout",
        latestReportSeq: null,
        answeredReportSeq: null,
        startedAt: new Date().toISOString(),
        tokens: 0,
        activity: [],
      },
    });
    this.emit("roster");

    try {
      await excludeBenchDir(input.project);
      // Without isolation the specialist works where the developer works: the
      // checkout itself, on whatever branch is already there. Nothing is
      // created, so nothing is Bench's to take away again.
      const { worktree, branch } = isolated
        ? await createWorktree(input.project, input.label, id)
        : { worktree: input.project, branch: await currentBranch(input.project) };
      await mkdir(reportsDir, { recursive: true });

      const port = 3100 + this.entries.size;
      await bootstrapWorktree({
        repo: input.project,
        worktree,
        port,
        onStep: (step) => this.update(id, "provisioning", step),
      });

      const entry = this.entries.get(id)!;
      entry.worktree = worktree;
      entry.branch = branch;
      entry.port = port;
      this.attach(id, {
        label: input.label,
        worktree,
        model: input.model,
        port,
      });
      // The process waits. A specialist is given work by prompting it, not
      // by being created.
      await this.store.put({
        id, label: input.label, role, project: input.project, worktree, branch, reportsDir,
        model: input.model, port, createdAt: new Date().toISOString(), isolated,
      });
      this.update(id, "awaiting_decision", "ready");
    } catch (error) {
      const detail = error instanceof BootstrapError
        ? `${error.step}: ${error.stderr.trim().slice(0, 200)}`
        : String(error);
      this.update(id, "provisioning_failed", detail);
    }

    return id;
  }

  /** Every prompt takes the same path in. What the turn becomes is the
   * agent's call. */
  send(id: string, text: string): void {
    const entry = this.entries.get(id);
    if (!entry) return;

    // A specialist restored from disk has no process yet. Bring it back on
    // the first prompt, resuming the transcript the CLI still holds, so it
    // remembers what it was doing.
    if (!entry.session) {
      if (!existsSync(entry.worktree)) {
        this.update(id, "crashed", "worktree is gone");
        return;
      }
      this.attach(id, {
        label: entry.row.label,
        worktree: entry.worktree,
        model: entry.model,
        port: entry.port,
        // Only ever resume a conversation that exists. Asking the CLI to
        // resume one that does not prints "No conversation found with session
        // ID" and exits before the prompt is ever read.
        resume: entry.resumable,
        // Pick up the numbering where it stopped, or this turn writes over
        // the last one's report.
        startTurn: entry.turnsTaken,
      });
    }

    void appendEntry(entry.threadPath, { kind: "user", body: text });
    // Prompting a specialist is how a decision gets answered, so whatever
    // was on the table is answered now.
    entry.row.answeredReportSeq = entry.row.latestReportSeq;
    // The trail describes the turn in flight, so it starts empty.
    entry.row.activity = [];
    entry.session!.send(text);
    this.update(id, "working", "starting");
  }

  /**
   * End the turn a specialist is in the middle of.
   *
   * The process goes; the specialist does not. Its worktree, its thread and
   * its reports are untouched, and the next prompt brings it back from the
   * last turn it finished - so what is lost is the turn in flight, which is
   * what the developer asked to lose.
   *
   * Marked before the kill so the exit is read as a decision rather than as
   * a crash. "Process exited" is what a specialist that fell over says, and
   * telling the developer that about something they just did themselves is
   * how a roster stops being believed.
   */
  stop(id: string): void {
    const entry = this.entries.get(id);
    if (!entry?.session) return;
    entry.stopping = true;
    entry.session.stop();
  }

  /**
   * Close a specialist for good. The store is what boot reads, so deleting
   * the record is what makes it stay gone.
   *
   * The worktree goes too - it is the expensive part, and leaving one behind
   * per closed specialist is how a machine fills up. What is inside it is
   * not cheap, though, so anything uncommitted or unmerged stops the close
   * and says what would be lost. The thread and reports are kept: they are
   * small, and they are the record of what the specialist actually did.
   */
  async close(id: string, opts: { force?: boolean } = {}): Promise<{
    closed: boolean;
    changes: number;
    unmergedCommits: number;
  }> {
    const entry = this.entries.get(id);
    if (!entry) return { closed: false, changes: 0, unmergedCommits: 0 };

    const branch = entry.branch;
    // Closing a specialist that works in the checkout itself removes nothing,
    // so there is no work for it to destroy and nothing to warn about. The
    // developer's uncommitted changes stay exactly where they are.
    const state = entry.worktree === "" || !entry.isolated
      ? { clean: true, changes: 0, unmergedCommits: 0 }
      : await inspectWorktree(entry.row.project, entry.worktree, branch);

    if (!state.clean && !opts.force) {
      return { closed: false, changes: state.changes, unmergedCommits: state.unmergedCommits };
    }

    entry.session?.stop();
    // Only ever remove what Bench created. Pointed at a project checkout this
    // would be `git worktree remove --force` and `branch -D` against the
    // developer's own tree; git refuses both today, but not by our design.
    if (entry.isolated && entry.worktree !== "") {
      await removeWorktree(entry.row.project, entry.worktree, branch).catch(() => {});
    }
    await this.store.remove(id);
    this.entries.delete(id);
    this.emit("roster");

    return { closed: true, changes: state.changes, unmergedCommits: state.unmergedCommits };
  }
}
