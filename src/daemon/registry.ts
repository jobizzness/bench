import { EventEmitter } from "node:events";
import { mkdir, access } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { loadConfig } from "./config.js";
import { createServer, type SessionRegistryLike } from "./server.js";
import { createWorktree, excludeBenchDir } from "./worktree.js";
import { bootstrapWorktree, BootstrapError } from "./bootstrap.js";
import { ClaudeSession } from "./claude-session.js";
import { latestReportSeq, findReport } from "./reports.js";
import { resolveTurnOutcome } from "./turn-outcome.js";
import { appendEntry } from "./thread.js";
import type { RosterRow, SessionStatus } from "../shared/types.js";

interface Entry {
  row: RosterRow;
  reportsDir: string;
  threadPath: string;
  session: ClaudeSession | null;
  alive: boolean;
}

export class SessionRegistry extends EventEmitter implements SessionRegistryLike {
  private entries = new Map<string, Entry>();

  constructor(private readonly config: ReturnType<typeof loadConfig>) {
    super();
  }

  list(): RosterRow[] {
    return [...this.entries.values()].map((e) => e.row);
  }

  get(id: string): { reportsDir: string; threadPath: string; alive: boolean } | null {
    const entry = this.entries.get(id);
    return entry
      ? { reportsDir: entry.reportsDir, threadPath: entry.threadPath, alive: entry.alive }
      : null;
  }

  private update(id: string, status: SessionStatus, detail: string): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    entry.row.status = status;
    entry.row.detail = detail;
    this.emit("roster");
  }

  async create(input: { project: string; label: string; model: string }): Promise<string> {
    const id = randomUUID();
    const reportsDir = join(input.project, ".bench", "reports", id);

    this.entries.set(id, {
      reportsDir,
      threadPath: join(reportsDir, "thread.jsonl"),
      session: null,
      alive: false,
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

      const session = new ClaudeSession({
        id,
        label: input.label,
        worktree,
        reportsDir,
        hookCommand: this.config.hookCommand,
        pluginDir: this.config.pluginDir,
        model: input.model,
        port,
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

      this.entries.get(id)!.session = session;
      this.entries.get(id)!.alive = true;
      // Open the process and wait. A specialist is given work by prompting
      // it, not by being created.
      session.open();
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
    if (!entry?.session) return;
    void appendEntry(entry.threadPath, { kind: "user", body: text });
    entry.session.send(text);
    this.update(id, "working", "starting");
  }

  stop(id: string): void {
    this.entries.get(id)?.session?.stop();
  }
}
