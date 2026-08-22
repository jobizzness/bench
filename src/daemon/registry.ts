import { EventEmitter } from "node:events";
import { mkdir, access } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { loadConfig } from "./config.js";
import { createServer, type SessionRegistryLike } from "./server.js";
import { createWorktree, excludeBenchDir } from "./worktree.js";
import { bootstrapWorktree, BootstrapError } from "./bootstrap.js";
import { ClaudeSession } from "./claude-session.js";
import { existsSync } from "node:fs";
import { latestReportSeq, findReport } from "./reports.js";
import { SessionStore } from "./store.js";
import { resolveTurnOutcome } from "./turn-outcome.js";
import { appendEntry } from "./thread.js";
import type { RosterRow, SessionStatus } from "../shared/types.js";

interface Entry {
  row: RosterRow;
  reportsDir: string;
  threadPath: string;
  session: ClaudeSession | null;
  alive: boolean;
  /** Enough to bring the specialist back after the daemon has restarted. */
  worktree: string;
  model: string;
  port: number;
}

export class SessionRegistry extends EventEmitter implements SessionRegistryLike {
  private entries = new Map<string, Entry>();
  private readonly store: SessionStore;

  constructor(private readonly config: ReturnType<typeof loadConfig>) {
    super();
    this.store = new SessionStore(config.home);
  }

  /**
   * Rebuild the roster from disk. Nothing is spawned: a specialist costs
   * nothing until it is prompted, and the developer may only want to read
   * what an old one already wrote.
   */
  async restore(): Promise<void> {
    for (const rec of await this.store.all()) {
      const worktreeGone = !existsSync(rec.worktree);
      this.entries.set(rec.id, {
        reportsDir: rec.reportsDir,
        threadPath: join(rec.reportsDir, "thread.jsonl"),
        session: null,
        alive: false,
        worktree: rec.worktree,
        model: rec.model,
        port: rec.port,
        row: {
          id: rec.id,
          label: rec.label,
          project: rec.project,
          status: worktreeGone ? "crashed" : "awaiting_decision",
          detail: worktreeGone ? "worktree is gone" : "ready",
          latestReportSeq: await latestReportSeq(rec.reportsDir),
          startedAt: null,
          tokens: 0,
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

    session.on("activity", (line: string) => { syncProgress(); this.update(id, "working", line); });
    session.on("exit", () => {
      const entry = this.entries.get(id);
      if (entry) entry.alive = false;
      this.update(id, "crashed", "process exited");
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

  async create(input: { project: string; label: string; model: string }): Promise<string> {
    const id = randomUUID();
    const reportsDir = join(input.project, ".bench", "reports", id);

    this.entries.set(id, {
      reportsDir,
      threadPath: join(reportsDir, "thread.jsonl"),
      session: null,
      alive: false,
      worktree: "",
      model: input.model,
      port: 0,
      row: {
        id,
        label: input.label,
        project: input.project,
        status: "provisioning",
        detail: "creating worktree",
        latestReportSeq: null,
        startedAt: new Date().toISOString(),
        tokens: 0,
      },
    });
    this.emit("roster");

    try {
      await excludeBenchDir(input.project);
      const { worktree } = await createWorktree(input.project, input.label);
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
        id, label: input.label, project: input.project, worktree, reportsDir,
        model: input.model, port, createdAt: new Date().toISOString(),
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
        resume: true,
      });
    }

    void appendEntry(entry.threadPath, { kind: "user", body: text });
    entry.session!.send(text);
    this.update(id, "working", "starting");
  }

  stop(id: string): void {
    this.entries.get(id)?.session?.stop();
  }
}
