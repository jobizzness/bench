import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LineDecoder, userMessageLine, isResultEvent, activityLine, replyText } from "./stream-codec.js";
import { buildSettings } from "./gates/settings.js";

/** Enough for a refusal and a stack trace, not enough to hold a log file. */
const STDERR_KEPT = 4000;

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
  /** Turns this specialist has already taken. A revived one keeps counting
   * from where it stopped; starting again at one overwrites its own past. */
  startTurn?: number;
  /** Pick up a session the CLI already has a transcript for, rather than
   * starting a new one. Used when a specialist outlives the daemon. */
  resume?: boolean;
  /**
   * The developer's house rules, read fresh for every turn rather than
   * captured at spawn - a rule saved now has to reach the specialist already
   * running, and the framing is the only thing said again each turn.
   */
  rules?: () => string;
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
  private turnCount: number;

  constructor(private readonly opts: SessionOptions) {
    super();
    this.id = opts.id;
    this.turnCount = opts.startTurn ?? 0;
  }

  get turn(): number {
    return this.turnCount;
  }

  /** ISO time the running turn began, or null when idle. */
  get turnStartedAt(): string | null {
    return this.startedAt === null ? null : new Date(this.startedAt).toISOString();
  }

  get turnTokens(): number {
    return this.tokens;
  }

  /** Prompts waiting for the running turn to end. */
  private queued: string[] = [];
  private running = false;
  private startedAt: number | null = null;
  private tokens = 0;
  private lastStderr = "";

  /** Spawn the process and wait. A specialist with nothing to do costs
   * nothing: `claude -p` blocks on stdin until a prompt arrives. */
  open(): void {
    if (this.child) throw new Error("session already started");

    const bin = this.opts.claudeBin ?? "claude";
    const settings = JSON.stringify(buildSettings({ hookCommand: this.opts.hookCommand }));

    // --verbose is not optional: claude -p with stream-json exits without it.
    const args = [
      "-p",
      "--verbose",
      "--input-format", "stream-json",
      "--output-format", "stream-json",
      ...(this.opts.resume ? ["--resume", this.opts.id] : ["--session-id", this.opts.id]),
      "--name", this.opts.label,
      "--model", this.opts.model,
      "--permission-mode", "acceptEdits",
      // The reports directory lives with the project, not inside the
      // worktree, so it outlives a worktree that gets removed. Without this
      // it is simply outside the workspace and every write to it is refused.
      "--add-dir", this.opts.reportsDir,
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
    this.child.stderr.on("data", (chunk: string) => {
      // Kept rather than forwarded. When the CLI refuses to start it says why
      // on stderr and exits, and that line is the whole explanation - without
      // holding on to it the daemon can only report that a process exited.
      // It used to be emitted instead, which nothing listened to.
      this.lastStderr = (this.lastStderr + chunk).slice(-STDERR_KEPT);
    });
    // `close` rather than `exit`: exit can fire before the last stderr chunk
    // has been read, which is exactly the chunk worth having.
    this.child.on("close", (code) => {
      this.child = null;
      this.emit("exit", code, this.lastStderr.trim());
    });

  }

  /**
   * The developer's prompt. There is one kind of turn: whether it warrants a
   * report, a rendered reply or a plain sentence is the agent's call, not
   * something the UI can know in advance. Note that this does not interrupt -
   * a prompt sent mid-turn is answered once the running turn ends.
   */
  send(text: string): void {
    this.enqueue(text);
  }

  /**
   * Writing to stdin does not start a turn. The CLI buffers whatever arrives
   * while a turn is running and feeds it to that turn, so a message written
   * mid-turn is absorbed by the turn already in flight rather than answered
   * on its own. The queue therefore lives here: nothing reaches stdin until
   * the turn it belongs to actually begins, which is also what keeps its
   * framing - turn number and report directory - true when the agent reads
   * it.
   */
  private enqueue(text: string): void {
    if (!this.child) throw new Error("session not started");

    if (this.running) {
      // A turn is in flight. Hold the text; `consume` dispatches it when the
      // running turn ends.
      this.queued.push(text);
      return;
    }

    // Idle: this prompt becomes the running turn immediately.
    this.running = true;
    this.dispatch(text);
  }

  /** Begin a turn and hand it to the CLI. Only ever called for a turn that
   * starts now, so the framing matches the markers the gate reads. */
  private dispatch(text: string): void {
    const turn = this.turnCount + 1;
    this.beginTurn(turn);
    this.child!.stdin.write(userMessageLine(this.framed(text, turn)));
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
    this.startedAt = Date.now();
    this.tokens = 0;
    mkdirSync(this.opts.reportsDir, { recursive: true });
    writeFileSync(join(this.opts.reportsDir, ".turn"), String(turn));
  }

  private framed(text: string, turn: number): string {
    const dir = join(this.opts.reportsDir, String(turn));
    const rules = this.opts.rules?.() ?? "";
    // House rules sit between the mechanics and the ask: standing instructions
    // first, then what is wanted now, so the nearest thing to the prompt is
    // the prompt.
    const standing = rules === "" ? "" : `${rules}\n\n`;
    return `[bench] Turn ${turn}. This turn's artifact directory is ${dir}\n` +
      `Write a report there - bench-report skill, report.html and decision.json - ` +
      `when a decision needs the developer, when work is finished and they need ` +
      `to understand what it means, when a spec needs approving before you build, ` +
      `or when you are stuck. Otherwise just reply: use the bench-reply skill ` +
      `where the answer has structure worth rendering, plain prose where it does ` +
      `not. Which of those this turn is, is your call.\n` +
      `If this turn takes more than a couple of steps, keep a checklist at ` +
      `${join(dir, "plan.json")} - {"steps":[{"text":"...","state":"todo|doing|done"}]} - ` +
      `and update it as you go. It is the only way the developer can see where ` +
      `you have got to while you work.\n\n${standing}${text}`;
  }

  private consume(chunk: string): void {
    for (const event of this.decoder.push(chunk)) {
      const line = activityLine(event);
      if (line) this.emit("activity", line);

      // The CLI reports its own running estimate; no need to count tokens.
      if (event.type === "system" && event.subtype === "thinking_tokens") {
        const estimate = Number((event as { estimated_tokens?: unknown }).estimated_tokens);
        if (Number.isFinite(estimate) && estimate > this.tokens) {
          this.tokens = estimate;
          this.emit("progress");
        }
      }

      if (isResultEvent(event)) {
        // reply before turn-end, so a listener appending to the thread sees
        // the reply before the roster flips to awaiting-decision.
        const reply = replyText(event);

        // The turn that just finished releases the markers to the next
        // queued turn, which only now becomes the running one.
        this.running = false;
        this.startedAt = null;
        const next = this.queued.shift();
        if (next !== undefined) {
          this.running = true;
          this.dispatch(next);
        }

        if (reply) this.emit("reply", reply);
        this.emit("turn-end", event);
      }
    }
  }
}
