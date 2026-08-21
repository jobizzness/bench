import { EventEmitter } from "node:events";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { loadConfig } from "./config.js";
import { createServer, type SessionRegistryLike } from "./server.js";
import { createWorktree, excludeBenchDir } from "./worktree.js";
import { bootstrapWorktree, BootstrapError } from "./bootstrap.js";
import { ClaudeSession } from "./claude-session.js";
import { latestReportSeq } from "./reports.js";
import type { RosterRow, SessionStatus } from "../shared/types.js";

interface Entry {
  row: RosterRow;
  reportsDir: string;
  session: ClaudeSession | null;
}

class SessionRegistry extends EventEmitter implements SessionRegistryLike {
  private entries = new Map<string, Entry>();

  constructor(private readonly config: ReturnType<typeof loadConfig>) {
    super();
  }

  list(): RosterRow[] {
    return [...this.entries.values()].map((e) => e.row);
  }

  get(id: string): { reportsDir: string } | null {
    const entry = this.entries.get(id);
    return entry ? { reportsDir: entry.reportsDir } : null;
  }

  private update(id: string, status: SessionStatus, detail: string): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    entry.row.status = status;
    entry.row.detail = detail;
    this.emit("roster");
  }

  async create(input: { project: string; label: string; task: string; model: string }): Promise<string> {
    const id = randomUUID();
    const reportsDir = join(input.project, ".bench", "reports", id);

    this.entries.set(id, {
      reportsDir,
      session: null,
      row: {
        id,
        label: input.label,
        project: input.project,
        status: "provisioning",
        detail: "creating worktree",
        latestReportSeq: null,
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

      session.on("activity", (line: string) => this.update(id, "working", line));
      session.on("exit", () => this.update(id, "crashed", "process exited"));
      session.on("turn-end", async () => {
        const entry = this.entries.get(id);
        if (entry) entry.row.latestReportSeq = await latestReportSeq(reportsDir);
        this.update(id, "awaiting_decision", "waiting on you");
      });

      this.entries.get(id)!.session = session;
      session.start(input.task);
      this.update(id, "working", "starting");
    } catch (error) {
      const detail = error instanceof BootstrapError
        ? `${error.step}: ${error.stderr.trim().slice(0, 200)}`
        : String(error);
      this.update(id, "provisioning_failed", detail);
    }

    return id;
  }

  answer(id: string, text: string): void {
    const entry = this.entries.get(id);
    if (!entry?.session) return;
    entry.session.answer(text);
    this.update(id, "working", "resumed");
  }

  stop(id: string): void {
    this.entries.get(id)?.session?.stop();
  }
}

const config = loadConfig();
const registry = new SessionRegistry(config);
const server = createServer({ config, registry });

server.listen(config.port, "127.0.0.1", () => {
  process.stdout.write(`bench: http://127.0.0.1:${config.port}/?token=${config.token}\n`);
});

// Children are killed deliberately so no orphaned claude processes survive
// the daemon.
const shutdown = () => {
  for (const row of registry.list()) registry.stop(row.id);
  server.close(() => process.exit(0));
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
