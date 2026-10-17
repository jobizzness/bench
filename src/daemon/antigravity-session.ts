import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Context } from "../shared/context-window.js";
import { AGY_MODEL, ANTIGRAVITY_PREFIX, ANTIGRAVITY_LONG_PREFIX } from "../shared/models.js";
import type { Attachment } from "../shared/types.js";
import { antigravityContextWindow } from "./antigravity-models.js";
import { nextTurn } from "./reports.js";
import type { Session } from "./session.js";
import type { ResultEvent } from "./stream-codec.js";

const STDERR_KEPT = 4000;
const STOP_GRACE_MS = 5_000;

export interface AntigravitySessionOptions {
  id: string;
  worktree: string;
  reportsDir: string;
  role?: string;
  port?: number;
  cockpitUrl?: string;
  agyBin?: string;
  model?: string;
  startTurn?: number;
  resumeSessionId?: string;
  onSessionId?: (sessionId: string) => void | Promise<void>;
  rules?: () => string;
  nudge?: () => string;
}

interface Prompt {
  text: string;
  images: Attachment[];
}

function formatUserContent(text: string, images: Attachment[] = []): unknown {
  if (images.length === 0) return text;
  return [
    ...images.map((image) => ({
      type: "image",
      source: { type: "base64", media_type: image.mediaType, data: image.data },
    })),
    { type: "text", text },
  ];
}

function formatToolDetail(name: string, input: Record<string, unknown> | undefined): string {
  if (!input) return "";
  const command = input.command ?? input.CommandLine;
  if (typeof command === "string") return command.split("\n")[0].trim().slice(0, 60);
  const file = input.file_path ?? input.path ?? input.notebook_path ?? input.target_file ?? input.TargetFile ?? input.AbsolutePath;
  if (typeof file === "string") {
    const parts = file.split("/");
    return parts.slice(-2).join("/");
  }
  const query = input.query ?? input.pattern;
  if (typeof query === "string") return query.slice(0, 40);
  return "";
}

/**
 * A specialist session driven by Google Antigravity CLI (`agy`) over stdio
 * using `--input-format stream-json --output-format stream-json`.
 */
export class AntigravitySession extends EventEmitter implements Session {
  readonly id: string;
  private child: ChildProcessWithoutNullStreams | null = null;
  private turnCount: number;
  private running = false;
  private startedAt: number | null = null;
  private tokens = 0;
  private lastStepContextTokens = 0;
  private lifetimeTotalTokens = 0;
  private turnStartLifetimeTokens = 0;
  private context: Context | null = null;
  private queued: Prompt[] = [];
  private lastStderr = "";
  private sessionId?: string;
  private accumulatedText = "";
  private carry = "";

  constructor(private readonly opts: AntigravitySessionOptions) {
    super();
    this.id = opts.id;
    this.turnCount = opts.startTurn ?? 0;
    this.sessionId = opts.resumeSessionId;
  }

  get turn(): number {
    return this.turnCount;
  }

  get turnStartedAt(): string | null {
    return this.startedAt === null ? null : new Date(this.startedAt).toISOString();
  }

  get turnTokens(): number {
    return this.tokens;
  }

  get contextUsed(): Context | null {
    return this.context;
  }

  get turnAnsweredBy(): string[] {
    if (!this.opts.model) return [AGY_MODEL];
    const model = this.opts.model;
    return model.startsWith(ANTIGRAVITY_PREFIX) || model.startsWith(ANTIGRAVITY_LONG_PREFIX)
      ? [model]
      : [`${ANTIGRAVITY_PREFIX}${model}`];
  }

  get turnGenerationIds(): string[] {
    return [];
  }

  get runningTurn(): { ids: string[]; answeredBy: string[] } | null {
    if (this.startedAt === null) return null;
    return { ids: [], answeredBy: this.turnAnsweredBy };
  }

  open(): void {
    if (this.child) throw new Error("session already started");

    const bin = this.opts.agyBin ?? "agy";
    const args = [
      "--input-format", "stream-json",
      "--output-format", "stream-json",
      "--dangerously-skip-permissions",
      ...(this.opts.resumeSessionId ? ["--conversation", this.opts.resumeSessionId] : []),
      ...(this.opts.model ? ["--model", this.opts.model] : []),
      "--add-dir", this.opts.reportsDir,
    ];

    this.child = spawn(bin, args, {
      cwd: this.opts.worktree,
      env: {
        ...process.env,
        BENCH_SESSION_ID: this.opts.id,
        BENCH_REPORTS_DIR: this.opts.reportsDir,
        BENCH_SELF_MODEL: this.opts.model ? `${ANTIGRAVITY_PREFIX}${this.opts.model}` : AGY_MODEL,
        PORT: String(this.opts.port ?? 0),
        BENCH_URL: this.opts.cockpitUrl ?? "",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.child.stdout.on("data", (chunk: Buffer) => {
      this.carry += chunk.toString("utf8");
      const lines = this.carry.split("\n");
      this.carry = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const event = JSON.parse(trimmed) as Record<string, unknown>;
          this.handleEvent(event);
        } catch {
          // Ignore malformed line
        }
      }
    });

    this.child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      this.lastStderr = (this.lastStderr + text).slice(-STDERR_KEPT);
    });

    this.child.on("close", (code) => {
      this.child = null;
      this.running = false;
      this.emit("exit", code, this.lastStderr);
    });

    this.child.on("error", (error) => {
      this.lastStderr = (this.lastStderr + "\n" + error.message).slice(-STDERR_KEPT);
    });
  }

  private handleEvent(event: Record<string, unknown>): void {
    const eventType = typeof event.event === "string" ? event.event : typeof event.type === "string" ? event.type : "";

    if (eventType === "init") {
      const cid = typeof event.conversation_id === "string" ? event.conversation_id : undefined;
      if (cid) {
        this.sessionId = cid;
        void this.opts.onSessionId?.(cid);
      }
      return;
    }

    if (eventType === "step_update") {
      const step = event.step_update as Record<string, unknown> | undefined;
      if (!step) return;

      const usage = step.usage as Record<string, unknown> | undefined;
      if (usage) {
        const input = typeof usage.input_tokens === "number" ? usage.input_tokens : 0;
        const output = typeof usage.output_tokens === "number" ? usage.output_tokens : 0;
        const cacheRead = typeof usage.cache_read_tokens === "number" ? usage.cache_read_tokens : 0;
        const total = typeof usage.total_tokens === "number" ? usage.total_tokens : input + output;
        if (input + cacheRead > 0) {
          this.lastStepContextTokens = input + cacheRead;
        }
        if (total > 0) {
          this.tokens = Math.max(this.tokens, total);
          this.emit("progress");
        }
      }

      if (typeof step.text_delta === "string") {
        this.accumulatedText += step.text_delta;
      }

      const toolName = typeof step.tool_name === "string" ? step.tool_name : "";
      const toolInfo = step.tool_info as Record<string, unknown> | undefined;
      if (toolName || toolInfo || step.step_type === "tool_call") {
        const name = toolName || (typeof toolInfo?.name === "string" ? toolInfo.name : "Tool");
        const params = (toolInfo?.parameters ?? toolInfo?.input ?? step.parameters ?? step.input ?? toolInfo) as Record<string, unknown> | undefined;
        const detail = formatToolDetail(name, params);
        const line = detail ? `${name} ${detail}` : name;
        this.emit("activity", line);
      }
      return;
    }

    if (eventType === "result") {
      const result = (event.result ?? event) as Record<string, unknown>;
      const reply = (typeof result.response === "string" ? result.response.trim() : "") || this.accumulatedText.trim();
      if (reply) {
        this.emit("reply", reply);
      }

      const usage = (result.usage as Record<string, unknown> | undefined) ?? {};
      const inTokens = typeof usage.input_tokens === "number" ? usage.input_tokens : 0;
      const outTokens = typeof usage.output_tokens === "number" ? usage.output_tokens : 0;
      const cacheRead = typeof usage.cache_read_tokens === "number" ? usage.cache_read_tokens : 0;
      const total = typeof usage.total_tokens === "number" ? usage.total_tokens : inTokens + outTokens;

      // agy reports cumulative total tokens across all turns in the process lifecycle.
      // Compute this turn's spend as delta above what had accumulated before this turn started.
      if (total >= this.turnStartLifetimeTokens && this.turnStartLifetimeTokens > 0) {
        this.tokens = total - this.turnStartLifetimeTokens;
      } else {
        this.tokens = total;
      }
      this.lifetimeTotalTokens = Math.max(this.lifetimeTotalTokens, total);

      const window = typeof usage.context_window === "number" && usage.context_window > 0
        ? usage.context_window
        : antigravityContextWindow(this.opts.model);

      // What the conversation actually occupies in the model's context window is what the
      // last model request sent (input_tokens + cache_read_tokens). result.usage.input_tokens
      // is the cumulative sum of all requests across tool steps (and across turns), which
      // quickly exceeds the window. If no step_update usage was captured, fall back to
      // inTokens + cacheRead, clamped to window.
      let used = this.lastStepContextTokens;
      if (used <= 0) {
        used = inTokens + cacheRead;
      }
      if (used > window) {
        used = this.context?.used && this.context.used <= window ? this.context.used : Math.min(used, window);
      }
      this.context = { used, window };

      const status = typeof result.status === "string" ? result.status : "SUCCESS";
      const isError = status === "ERROR";
      const resultEvent: ResultEvent = {
        type: "result",
        subtype: status,
        is_error: isError,
        session_id: (typeof result.conversation_id === "string" ? result.conversation_id : this.sessionId) ?? this.opts.id,
        result: reply,
        usage: {
          totalTokens: this.tokens,
          inputTokens: inTokens,
          outputTokens: outTokens,
          cachedReadTokens: cacheRead,
        },
      };

      this.running = false;
      this.startedAt = null;
      this.accumulatedText = "";
      this.emit("turn-end", resultEvent);

      if (this.queued.length > 0) {
        const next = this.queued.shift()!;
        this.dispatch(next);
      }
    }
  }

  send(text: string, images: Attachment[] = []): void {
    if (this.running) {
      this.queued.push({ text, images });
      return;
    }
    this.dispatch({ text, images });
  }

  private dispatch(prompt: Prompt): void {
    if (!this.child) {
      this.open();
    }
    const turn = nextTurn(this.opts.reportsDir, this.turnCount);
    this.beginTurn(turn);
    this.running = true;

    const message = {
      event: "user",
      message: {
        role: "user",
        content: formatUserContent(this.framed(prompt.text, turn, prompt.images.length), prompt.images),
      },
    };

    this.child!.stdin.write(JSON.stringify(message) + "\n");
  }

  private beginTurn(turn: number): void {
    this.turnCount = turn;
    this.startedAt = Date.now();
    this.tokens = 0;
    this.lastStepContextTokens = 0;
    this.turnStartLifetimeTokens = this.lifetimeTotalTokens;
    this.accumulatedText = "";
    mkdirSync(this.opts.reportsDir, { recursive: true });
    writeFileSync(join(this.opts.reportsDir, ".turn"), String(turn));
  }

  private framed(text: string, turn: number, imageCount = 0): string {
    const dir = join(this.opts.reportsDir, String(turn));
    const rules = this.opts.rules?.() ?? "";
    const nudge = this.opts.nudge?.() ?? "";
    const standing = [rules, nudge].filter((s) => s !== "").join("\n\n");
    const standingBlock = standing === "" ? "" : `${standing}\n\n`;
    const attached = imageCount === 0 ? "" : `[bench] The developer attached `
      + `${imageCount === 1 ? "an image" : `${imageCount} images`} to this message, `
      + `immediately above this text.\n\n`;
    return `[bench] Turn ${turn}. This turn's artifact directory is ${dir}\n` +
      `Write a report there - bench-report skill, report.html and decision.json - ` +
      `when a decision needs the developer, when work is finished and they need ` +
      `to understand what it means, when a spec needs approving before you build, ` +
      `or when you are stuck. Otherwise just reply: use the bench-reply skill ` +
      `where the answer has structure worth rendering, plain prose where it does ` +
      `not. Never say a report is ready when you wrote no report.html.\n\n` +
      standingBlock +
      attached +
      text;
  }

  stop(): void {
    if (!this.child) return;
    const proc = this.child;
    this.child = null;
    this.running = false;
    proc.kill("SIGTERM");
    const pid = proc.pid;
    setTimeout(() => {
      try {
        if (pid) process.kill(pid, 0) && process.kill(pid, "SIGKILL");
      } catch {
        // Process already gone
      }
    }, STOP_GRACE_MS).unref?.();
  }
}
