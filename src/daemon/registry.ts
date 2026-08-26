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
import { labelIsUsable } from "../shared/slug.js";
import { houseRules, readSettings, writeSettings, NO_SETTINGS, type Settings } from "./settings.js";
import { keyHint } from "./anthropic-key.js";
import { catalogue, isOpenRouterModel, type Listed } from "./openrouter.js";
import { isModelId, modelLabel } from "../shared/models.js";
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
  /**
   * Why, when it was not simply "stop".
   *
   * Moving a specialist to another model also has to let the process go, and
   * a row that says "stopped by you" for that is a row that misreports a
   * thing the developer did not do.
   */
  stoppedBecause?: string;
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
  /**
   * The developer's own Anthropic key, when they have given one.
   *
   * In memory and nowhere else. It overrides a login the daemon already has,
   * and an override that survives a restart is one you stop knowing about -
   * so it lasts exactly as long as the daemon that was told it.
   */
  private apiKey: string | null = null;

  /**
   * Whether that key is the one being handed out.
   *
   * Off is parked, not gone: switching between your own key and the machine's
   * login is a thing you do several times in an afternoon, and a switch that
   * forgets the key makes you paste it again every time.
   */
  private apiKeyOn = true;

  /**
   * The developer's OpenRouter key, for specialists run on anybody other than
   * Anthropic. In memory and nowhere else, the same rule the Anthropic key
   * follows: an override kept in a file is one you forget you set.
   */
  private routerKey: string | null = null;

  /** The catalogue, once fetched. OpenRouter serves several hundred models
   * and the list changes rarely, so it is read once and kept rather than
   * fetched every time the picker opens. */
  private models: Listed[] | null = null;

  constructor(private readonly config: ReturnType<typeof loadConfig>) {
    super();
    this.store = new SessionStore(config.home);
  }

  /**
   * What a specialist needs to be answered by OpenRouter, or undefined when
   * it is an Anthropic model and nothing has to change.
   *
   * Throws rather than returning undefined when the model needs a key there
   * is not - the message is the one the developer reads in the dialog, so it
   * says what to do rather than what failed.
   */
  private async viaFor(model: string): Promise<{ key: string; contextLength?: number | null } | undefined> {
    if (!isOpenRouterModel(model)) return undefined;
    if (this.routerKey === null) {
      throw new Error("no OpenRouter key - add one in Settings to run a specialist on this model");
    }
    // The window this model actually has. Best effort: if the catalogue
    // cannot be reached the specialist still starts, on the CLI's own
    // assumption, which is worse than the truth but better than nothing.
    const listed = (await this.catalogue().catch(() => [] as Listed[]))
      .find((m) => m.id === model);
    return { key: this.routerKey, contextLength: listed?.contextLength ?? null };
  }

  /** Every model OpenRouter serves, fetched once. */
  async catalogue(): Promise<Listed[]> {
    if (this.models === null) this.models = await catalogue();
    return this.models;
  }

  getSettings(): Settings {
    return this.settings;
  }

  /** What may be said about the key: that there is one, and which one. Never
   * the key - it goes to the daemon and does not come back. */
  apiKeyState(): { present: boolean; hint: string; enabled: boolean } {
    return this.apiKey === null
      ? { present: false, hint: "", enabled: this.apiKeyOn }
      : { present: true, hint: keyHint(this.apiKey), enabled: this.apiKeyOn };
  }

  /** The key to authenticate with, which is nothing at all while it is
   * switched off - callers should see a parked key exactly as they see no
   * key, and fall back to whatever the machine already has. */
  getApiKey(): string | null {
    return this.apiKeyOn ? this.apiKey : null;
  }

  setApiKey(key: string): void {
    this.apiKey = key;
    // Saving a key is asking for it to be used. Inheriting "off" from the key
    // it replaced would be a key that quietly does nothing.
    this.apiKeyOn = true;
  }

  setApiKeyEnabled(on: boolean): void {
    this.apiKeyOn = on;
  }

  /** What may be said about the OpenRouter key: that there is one, and which
   * one. Never the key - it goes to the daemon and does not come back. */
  routerKeyState(): { present: boolean; hint: string } {
    return this.routerKey === null
      ? { present: false, hint: "" }
      : { present: true, hint: keyHint(this.routerKey) };
  }

  setRouterKey(key: string): void {
    this.routerKey = key;
  }

  clearRouterKey(): void {
    this.routerKey = null;
  }

  clearApiKey(): void {
    this.apiKey = null;
    this.apiKeyOn = true;
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
  /**
   * A write to the index that nobody is waiting on.
   *
   * Nobody waiting is not nobody watching: an unawaited promise that rejects
   * is an unhandled rejection, and node ends the process for one of those.
   * A turn's context number failing to save is worth a line on stderr. It is
   * not worth six specialists.
   */
  private remember(work: Promise<unknown>): void {
    void work.catch((error) => {
      process.stderr.write(`bench: could not update the specialist index: ${String(error)}\n`);
    });
  }

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
          branch: rec.branch ?? `worktree-${rec.label}`,
          isolated: rec.isolated ?? true,
          project: rec.project,
          model: rec.model,
          status: worktreeGone ? "crashed" : "awaiting_decision",
          detail: worktreeGone ? "worktree is gone" : "ready",
          latestReportSeq: await latestReportSeq(rec.reportsDir),
          // Derived from the thread rather than stored: the conversation
          // already records who spoke last, so it cannot drift.
          answeredReportSeq: answeredReportSeq(thread),
          startedAt: null,
          tokens: 0,
          context: rec.context ?? null,
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
    /** Set for an OpenRouter model, already resolved. */
    via?: { key: string; contextLength?: number | null };
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
      apiKey: () => this.apiKey,
      via: opts.via,
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
      if (entry) {
        entry.alive = false;
        // Let go of it. A session whose process has gone refuses everything
        // sent to it, and holding the reference meant the next message took
        // the "already running" path and threw - which, inside a request
        // handler, took the whole daemon with it. Cleared, the next prompt
        // takes the revival path, which is what a stopped specialist is for.
        entry.session = null;
      }

      // Asked for, not suffered. The specialist is still here and its next
      // prompt revives it from the last turn it finished.
      if (entry?.stopping) {
        entry.stopping = false;
        const because = entry.stoppedBecause ?? "stopped by you";
        entry.stoppedBecause = undefined;
        this.update(id, "awaiting_decision", because);
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

      // How full the conversation is now. Kept on disk as well as on the row:
      // a cockpit that has just started should be able to say whether a cold
      // specialist is worth reviving without prompting it first.
      const context = session.contextUsed;
      if (context) {
        entry.row.context = context;
        this.remember(this.store.rememberContext(id, context));
      }

      // A turn has ended, so the CLI has written a conversation and the next
      // process can pick it up.
      if (!entry.resumable) {
        entry.resumable = true;
        this.remember(this.store.markResumable(id));
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

    // Before anything is created. A model that needs an OpenRouter key and
    // has none is the developer's problem while they are still looking at the
    // dialog they asked from - not a row on the roster that provisioned a
    // worktree and then died on its first turn.
    const via = await this.viaFor(input.model);

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
        branch: "",
        isolated,
        project: input.project,
        model: input.model,
        status: "provisioning",
        detail: isolated ? "creating worktree" : "opening the checkout",
        latestReportSeq: null,
        answeredReportSeq: null,
        startedAt: new Date().toISOString(),
        tokens: 0,
        context: null,
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
      // The row is made before the worktree exists, so this is the first
      // moment there is a branch to name.
      entry.row.branch = branch;
      entry.port = port;
      this.attach(id, {
        label: input.label,
        worktree,
        model: input.model,
        port,
        via,
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
  /** Bring a cold specialist back, on whatever backend it was made on. */
  private revive(id: string, entry: Entry, via: { key: string; contextLength?: number | null } | undefined): ClaudeSession {
    return this.attach(id, {
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
      via,
    });
  }

  send(id: string, text: string): void {
    const entry = this.entries.get(id);
    if (!entry) return;

    // A specialist restored from disk has no process yet. Bring it back on
    // the first prompt, resuming the transcript the CLI still holds, so it
    // remembers what it was doing.
    // A specialist restored from disk has no process yet, and no worktree to
    // bring one back into is the end of it.
    if (!entry.session && !existsSync(entry.worktree)) {
      this.update(id, "crashed", "worktree is gone");
      return;
    }

    void appendEntry(entry.threadPath, { kind: "user", body: text });
    // Prompting a specialist is how a decision gets answered, so whatever
    // was on the table is answered now.
    entry.row.answeredReportSeq = entry.row.latestReportSeq;
    // The trail describes the turn in flight, so it starts empty.
    entry.row.activity = [];

    if (entry.session) {
      entry.session.send(text);
      this.update(id, "working", "starting");
      return;
    }

    // Cold, so this prompt revives it.
    //
    // A specialist that needs no proxy is revived here and now, exactly as it
    // always was. Only a proxied one has to wait, and it waits because the
    // proxy may not be up: a CLI pointed at a base URL nothing is listening
    // on retries with a doubling delay, so skipping the wait would turn a
    // stopped proxy into a specialist that hangs for two minutes.
    if (!isOpenRouterModel(entry.model)) {
      this.revive(id, entry, undefined);
      entry.session!.send(text);
      this.update(id, "working", "starting");
      return;
    }

    // Slow enough on a first run that saying nothing would read as a prompt
    // that went nowhere.
    this.update(id, "working", "waking up");
    void this.viaFor(entry.model).then(
      (via) => {
        this.revive(id, entry, via);
        entry.session!.send(text);
        this.update(id, "working", "starting");
      },
      (error: unknown) => {
        this.update(id, "crashed", error instanceof Error ? error.message : String(error));
      },
    );
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
  /**
   * Rename a specialist.
   *
   * The label only; the branch and the worktree keep the names they were
   * given. Renaming those means moving a checked-out worktree and a branch
   * that may already be pushed, to change a string nobody reads except in
   * `git branch` - and the stage head shows the branch, so the two drifting
   * apart is visible rather than hidden.
   */
  rename(id: string, label: string): boolean {
    const entry = this.entries.get(id);
    if (!entry || !labelIsUsable(label)) return false;

    entry.row.label = label.trim();
    this.remember(this.store.rename(id, entry.row.label));
    this.emit("roster");
    return true;
  }

  /**
   * Put a specialist on a different model.
   *
   * The running process cannot be moved: `--model` is fixed at spawn, and so
   * is the base URL that decides who answers. So the change is recorded and
   * the process is let go of - the next prompt revives it on the new model,
   * resuming the same transcript, which is the path a cold specialist already
   * takes every time the daemon restarts.
   *
   * Lazy rather than eager on purpose. Restarting here would spend a turn's
   * startup on a decision the developer might still be thinking about, and a
   * specialist that is mid-turn would lose the turn.
   */
  async setModel(id: string, model: string): Promise<void> {
    const entry = this.entries.get(id);
    if (!entry) throw new Error("no such specialist");
    if (!isModelId(model)) throw new Error("not a model this bench offers");
    if (entry.model === model) return;

    // Before anything is recorded. Moving onto a provider with no key, or
    // with no way to run its proxy, fails here - while the developer is
    // still looking at the modal - rather than on the next prompt.
    await this.viaFor(model);

    entry.model = model;
    entry.row.model = model;
    this.remember(this.store.remodel(id, model));

    // A live process is now running the wrong model. Let it go; the next
    // prompt brings it back on the new one. Deliberately not `stop()`, which
    // means "the developer stopped this" and says so on the row.
    if (entry.session) {
      entry.stopping = true;
      entry.stoppedBecause = `moved to ${modelLabel(model)}`;
      entry.session.stop();
    } else {
      this.emit("roster");
    }
  }

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
