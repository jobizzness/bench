import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LineDecoder, userMessageLine, isResultEvent, activityLine } from "./stream-codec.js";
import { buildSettings } from "./gates/settings.js";

export interface SessionOptions {
  id: string;
  label: string;
  worktree: string;
  reportsDir: string;
  hookCommand: string;
  pluginDir: string;
  model: string;
  port: number;
  claudeBin?: string;
}

/**
 * One long-lived `claude` process. In stream-json mode the process runs,
 * emits a `result` event, then blocks on stdin - so the turn is the unit of
 * control and no separate "needs input" protocol is required.
 */
export class ClaudeSession extends EventEmitter {
  readonly id: string;
  private child: ChildProcessWithoutNullStreams | null = null;
  private decoder = new LineDecoder();
  private turnCount = 0;

  constructor(private readonly opts: SessionOptions) {
    super();
    this.id = opts.id;
  }

  get turn(): number {
    return this.turnCount;
  }

  start(task: string): void {
    if (this.child) throw new Error("session already started");

    const bin = this.opts.claudeBin ?? "claude";
    const settings = JSON.stringify(buildSettings({ hookCommand: this.opts.hookCommand }));

    // --verbose is not optional: claude -p with stream-json exits without it.
    const args = [
      "-p",
      "--verbose",
      "--input-format", "stream-json",
      "--output-format", "stream-json",
      "--session-id", this.opts.id,
      "--name", this.opts.label,
      "--model", this.opts.model,
      "--permission-mode", "acceptEdits",
      "--settings", settings,
      "--plugin-dir", this.opts.pluginDir,
    ];

    this.child = spawn(bin, args, {
      cwd: this.opts.worktree,
      env: {
        ...process.env,
        BENCH_SESSION_ID: this.opts.id,
        BENCH_REPORTS_DIR: this.opts.reportsDir,
        PORT: String(this.opts.port),
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => this.consume(chunk));
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk: string) => this.emit("stderr", chunk));
    this.child.on("exit", (code) => {
      this.child = null;
      this.emit("exit", code);
    });

    this.beginTurn(1);
    this.child.stdin.write(userMessageLine(this.framed(task)));
  }

  answer(text: string): void {
    if (!this.child) throw new Error("session not started");
    this.beginTurn(this.turnCount + 1);
    this.child.stdin.write(userMessageLine(this.framed(text)));
  }

  stop(): void {
    this.child?.kill("SIGTERM");
  }

  /**
   * The turn number cannot live in the environment: env is fixed at spawn
   * and a session runs many turns. The gate reads it from this file, which
   * is rewritten before every turn.
   */
  private beginTurn(turn: number): void {
    this.turnCount = turn;
    mkdirSync(this.opts.reportsDir, { recursive: true });
    writeFileSync(join(this.opts.reportsDir, ".turn"), String(turn));
  }

  private framed(text: string): string {
    const reportDir = join(this.opts.reportsDir, String(this.turnCount));
    return `[bench] Turn ${this.turnCount}. Write this turn's report into ${reportDir}\n\n${text}`;
  }

  private consume(chunk: string): void {
    for (const event of this.decoder.push(chunk)) {
      const line = activityLine(event);
      if (line) this.emit("activity", line);
      if (isResultEvent(event)) this.emit("turn-end", event);
    }
  }
}
