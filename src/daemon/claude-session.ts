import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LineDecoder, userMessageLine, isResultEvent, activityLine, replyText } from "./stream-codec.js";
import { buildSettings } from "./gates/settings.js";
import type { TurnKind } from "../shared/types.js";

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
  private currentKind: TurnKind = "work";

  constructor(private readonly opts: SessionOptions) {
    super();
    this.id = opts.id;
  }

  get turn(): number {
    return this.turnCount;
  }

  get turnKind(): TurnKind {
    return this.currentKind;
  }

  /** Turns whose text is already on stdin but which have not begun yet. */
  private queued: Array<{ text: string; kind: TurnKind }> = [];
  private running = false;

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

    this.running = true;
    this.beginTurn(1, "work");
    this.child.stdin.write(userMessageLine(this.framed(task, 1, "work")));
  }

  answer(text: string): void {
    this.enqueue(text, "work");
  }

  /**
   * A question, not a work request. Exempt from the report gate. Note that
   * this does not interrupt: if a turn is running, the message queues and
   * is answered once that turn ends.
   */
  message(text: string): void {
    this.enqueue(text, "chat");
  }

  /**
   * Writing to stdin does not start a turn - the CLI buffers it until the
   * running turn ends. So the text goes out now, but the on-disk markers
   * that the report gate reads must not move until this turn actually
   * begins. Advancing them here would let a queued chat message exempt the
   * running work turn from its report.
   */
  private enqueue(text: string, kind: TurnKind): void {
    if (!this.child) throw new Error("session not started");

    if (this.running) {
      // A turn is in flight. The text goes to stdin now and the CLI buffers
      // it, but the markers stay on the running turn until it ends.
      const turn = this.turnCount + this.queued.length + 1;
      this.queued.push({ text, kind });
      this.child.stdin.write(userMessageLine(this.framed(text, turn, kind)));
      return;
    }

    // Idle: this message becomes the running turn immediately.
    this.running = true;
    const turn = this.turnCount + 1;
    this.beginTurn(turn, kind);
    this.child.stdin.write(userMessageLine(this.framed(text, turn, kind)));
  }

  stop(): void {
    this.child?.kill("SIGTERM");
  }

  /**
   * The turn number cannot live in the environment: env is fixed at spawn
   * and a session runs many turns. The gate reads it from this file, which
   * is rewritten before every turn.
   */
  private beginTurn(turn: number, kind: TurnKind): void {
    this.turnCount = turn;
    this.currentKind = kind;
    mkdirSync(this.opts.reportsDir, { recursive: true });
    writeFileSync(join(this.opts.reportsDir, ".turn"), String(turn));
    writeFileSync(join(this.opts.reportsDir, ".turn-kind"), kind);
  }

  private framed(text: string, turn: number, kind: TurnKind): string {
    if (kind === "chat") {
      const dir = join(this.opts.reportsDir, String(turn));
      return `[bench] Turn ${turn}. This is a question, not a work request - ` +
        `no report is required. Use the bench-reply skill: write your answer as ` +
        `${join(dir, "reply.html")} and keep your spoken response to a single ` +
        `summary line. Answer in plain prose only if the answer is genuinely ` +
        `one short sentence with no structure.\n\n${text}`;
    }
    const reportDir = join(this.opts.reportsDir, String(turn));
    return `[bench] Turn ${turn}. Write this turn's report into ${reportDir}\n\n${text}`;
  }

  private consume(chunk: string): void {
    for (const event of this.decoder.push(chunk)) {
      const line = activityLine(event);
      if (line) this.emit("activity", line);

      if (isResultEvent(event)) {
        // reply before turn-end, so a listener appending to the thread sees
        // the reply before the roster flips to awaiting-decision.
        const reply = replyText(event);
        const endedKind = this.currentKind;

        // The turn that just finished releases the markers to the next
        // queued turn, which only now becomes the running one.
        this.running = false;
        const next = this.queued.shift();
        if (next) {
          this.running = true;
          this.beginTurn(this.turnCount + 1, next.kind);
        }

        if (reply) this.emit("reply", reply, endedKind);
        this.emit("turn-end", event);
      }
    }
  }
}
