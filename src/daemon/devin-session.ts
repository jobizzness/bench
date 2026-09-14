import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Context } from "../shared/context-window.js";
import { COST_AWARENESS_BRIEF, DEFAULT_ROLE, ROLE_BRIEF, type Role } from "../shared/roles.js";
import type { Attachment } from "../shared/types.js";
import type { Session } from "./session.js";
import type { ResultEvent } from "./stream-codec.js";

const STDERR_KEPT = 4000;
const CLEAN_STOP_REASONS = new Set(["end_turn"]);

/**
 * Read the Windsurf/Devin API key that `devin auth login` stores on disk.
 * The real `devin acp` process ignores local CLI credentials in ACP mode and
 * requires the host to call `authenticate` — this is what we pass there.
 */
function readDevinApiKey(): string | null {
  try {
    const xdgData = process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share");
    const content = readFileSync(join(xdgData, "devin", "credentials.toml"), "utf8");
    const match = /^\s*windsurf_api_key\s*=\s*"([^"]+)"/m.exec(content);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

export interface DevinSessionOptions {
  id: string;
  worktree: string;
  reportsDir: string;
  role?: Role;
  port?: number;
  cockpitUrl?: string;
  devinBin?: string;
  /**
   * The Devin/Windsurf API key to pass in the ACP `authenticate` call.
   * When absent the session reads it from the credentials file that
   * `devin auth login` writes (`$XDG_DATA_HOME/devin/credentials.toml`).
   * Only ever set explicitly by tests that need to control the value
   * without touching the filesystem.
   */
  devinApiKey?: string;
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

interface RpcMessage {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown> | null;
  error?: unknown;
}

function compacted(prompts: string[]): string {
  const intro =
    "The developer sent these while you were still on the turn before this "
    + "one. Answer them together, as one turn, not one at a time:";
  return [intro, ...prompts.map((prompt, index) => `${index + 1}. ${prompt}`)].join("\n\n");
}

function folded(prompts: Prompt[]): Prompt {
  if (prompts.length === 1) return prompts[0];
  const images = prompts.flatMap((prompt) => prompt.images);
  const texts = prompts.map((prompt) => prompt.images.length === 0
    ? prompt.text
    : `${prompt.text}\n(with ${prompt.images.length === 1 ? "1 image" : `${prompt.images.length} images`}, in order, below)`);
  return { text: compacted(texts), images };
}

export class DevinSession extends EventEmitter implements Session {
  private child: ChildProcessWithoutNullStreams | null = null;
  private carry = "";
  private lastStderr = "";
  private nextRequestId = 0;
  private initializeRequestId: number | null = null;
  private setupRequestId: number | null = null;
  private authenticateRequestId: number | null = null;
  private promptRequestId: number | null = null;
  private sessionId: string | null = null;
  private ready = false;
  private running = false;
  private queued: Prompt[] = [];
  private pending: Prompt | null = null;
  private reply = "";
  private startedAt: number | null = null;
  private turnCount: number;
  private firstPrompt = true;

  constructor(private readonly opts: DevinSessionOptions) {
    super();
    this.turnCount = opts.startTurn ?? 0;
    this.firstPrompt = opts.resumeSessionId === undefined;
  }

  get turnStartedAt(): string | null {
    return this.startedAt === null ? null : new Date(this.startedAt).toISOString();
  }

  // ACP exposes no documented per-turn token feed for Devin.
  get turnTokens(): number { return 0; }

  get turn(): number { return this.turnCount; }

  // Devin exposes no documented context-window figure Bench can consume.
  get contextUsed(): Context | null { return null; }

  // These identify OpenRouter requests and have no meaning for Devin.
  get turnAnsweredBy(): string[] { return []; }
  get turnGenerationIds(): string[] { return []; }

  get runningTurn(): { ids: string[]; answeredBy: string[] } | null {
    return this.startedAt === null ? null : { ids: [], answeredBy: [] };
  }

  open(): void {
    if (this.child) throw new Error("session already started");
    this.child = spawn(this.opts.devinBin ?? "devin", ["acp"], {
      cwd: this.opts.worktree,
      env: {
        ...process.env,
        BENCH_SESSION_ID: this.opts.id,
        BENCH_REPORTS_DIR: this.opts.reportsDir,
        BENCH_SELF_MODEL: "devin",
        PORT: this.opts.port === undefined ? undefined : String(this.opts.port),
        BENCH_URL: this.opts.cockpitUrl,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => this.consume(chunk));
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk: string) => {
      this.lastStderr = (this.lastStderr + chunk).slice(-STDERR_KEPT);
    });
    this.child.on("error", (error) => {
      this.lastStderr = (this.lastStderr + String(error)).slice(-STDERR_KEPT);
    });
    this.child.stdin.on("error", () => {});
    this.child.on("close", (code) => {
      this.child = null;
      this.ready = false;
      this.emit("exit", code, this.lastStderr.trim());
    });

    this.initializeRequestId = this.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: {},
      clientInfo: { name: "bench", title: "Bench", version: "0.1.0" },
    });
  }

  send(text: string, images: Attachment[] = []): void {
    if (!this.child) throw new Error("session not started");
    const prompt = { text, images };
    if (!this.ready) {
      if (this.pending) this.queued.push(prompt);
      else this.pending = prompt;
      return;
    }
    this.enqueue(prompt);
  }

  stop(): void {
    this.child?.kill("SIGTERM");
  }

  private request(method: string, params: Record<string, unknown>): number {
    const id = this.nextRequestId++;
    this.write({ jsonrpc: "2.0", id, method, params });
    return id;
  }

  private write(message: unknown): void {
    this.child!.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private consume(chunk: string): void {
    this.carry += chunk;
    const lines = this.carry.split("\n");
    this.carry = lines.pop() ?? "";
    for (const line of lines) {
      if (line.trim() === "") continue;
      let message: RpcMessage;
      try {
        message = JSON.parse(line) as RpcMessage;
      } catch {
        continue;
      }
      this.handle(message);
    }
  }

  private handle(message: RpcMessage): void {
    if (message.method === "session/update") {
      this.update(message.params?.update);
      return;
    }
    if (message.id === this.initializeRequestId) {
      if (message.error || message.result?.protocolVersion !== 1) {
        this.lastStderr = (this.lastStderr + `\nACP initialize failed: ${JSON.stringify(message.error ?? message.result)}`).slice(-STDERR_KEPT);
        this.stop();
        return;
      }
      // If the server advertises auth methods, authenticate before opening a
      // session. The real binary always requires this; the fake in tests
      // returns an empty array to skip the step without network access.
      const authMethods = message.result?.authMethods;
      if (Array.isArray(authMethods) && authMethods.length > 0) {
        const apiKey = this.opts.devinApiKey ?? readDevinApiKey();
        if (!apiKey) {
          this.lastStderr = (this.lastStderr + "\nDevin ACP requires authentication but no credentials were found. Run `devin auth login` first.").slice(-STDERR_KEPT);
          this.stop();
          return;
        }
        this.authenticateRequestId = this.request("authenticate", {
          methodId: "devin-browser",
          _meta: { api_key: apiKey },
        });
      } else {
        this.startSession();
      }
      return;
    }
    if (message.id === this.authenticateRequestId) {
      if (message.error) {
        this.lastStderr = (this.lastStderr + `\nDevin ACP authentication failed: ${JSON.stringify(message.error)}`).slice(-STDERR_KEPT);
        this.stop();
        return;
      }
      this.startSession();
      return;
    }
    if (message.id === this.setupRequestId) {
      if (message.error) {
        this.lastStderr = (this.lastStderr + `\nACP session setup failed: ${JSON.stringify(message.error)}`).slice(-STDERR_KEPT);
        this.stop();
        return;
      }
      const sessionId = this.opts.resumeSessionId ?? String(message.result?.sessionId ?? "");
      if (!sessionId) {
        this.lastStderr = (this.lastStderr + "\nACP session setup returned no session id").slice(-STDERR_KEPT);
        this.stop();
        return;
      }
      void this.finishSetup(sessionId);
      return;
    }
    if (message.id === this.promptRequestId) this.endTurn(message);
  }

  private startSession(): void {
    const method = this.opts.resumeSessionId ? "session/load" : "session/new";
    this.setupRequestId = this.request(method, {
      ...(this.opts.resumeSessionId ? { sessionId: this.opts.resumeSessionId } : {}),
      cwd: this.opts.worktree,
      mcpServers: [],
    });
  }

  private async finishSetup(sessionId: string): Promise<void> {
    this.sessionId = sessionId;
    try {
      if (!this.opts.resumeSessionId) await this.opts.onSessionId?.(sessionId);
    } catch (error) {
      this.lastStderr = (this.lastStderr + `\nCould not persist ACP session id: ${String(error)}`).slice(-STDERR_KEPT);
      this.stop();
      return;
    }
    this.ready = true;
    if (this.pending) {
      const prompt = this.pending;
      this.pending = null;
      this.enqueue(prompt);
    }
  }

  private update(value: unknown): void {
    if (!value || typeof value !== "object") return;
    const update = value as Record<string, unknown>;
    if (update.sessionUpdate === "agent_message_chunk") {
      const content = update.content;
      if (content && typeof content === "object" && (content as Record<string, unknown>).type === "text") {
        const text = (content as Record<string, unknown>).text;
        if (typeof text === "string") this.reply += text;
      }
    }
    if (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") {
      const title = typeof update.title === "string" ? update.title : undefined;
      const kind = typeof update.kind === "string" ? update.kind : undefined;
      const status = typeof update.status === "string" ? update.status : undefined;
      const line = [title ?? kind ?? "Tool", status].filter(Boolean).join(" — ");
      this.emit("activity", line);
    }
  }

  private enqueue(prompt: Prompt): void {
    if (this.running) {
      this.queued.push(prompt);
      return;
    }
    this.running = true;
    this.dispatch(prompt);
  }

  private dispatch(prompt: Prompt): void {
    const turn = this.turnCount + 1;
    this.beginTurn(turn);
    const role = this.firstPrompt
      ? `${ROLE_BRIEF[this.opts.role ?? DEFAULT_ROLE]}\n\n${COST_AWARENESS_BRIEF}\n\n`
      : "";
    this.firstPrompt = false;
    this.reply = "";
    this.promptRequestId = this.request("session/prompt", {
      sessionId: this.sessionId,
      prompt: [
        ...prompt.images.map((image) => ({ type: "image", mimeType: image.mediaType, data: image.data })),
        { type: "text", text: `${role}${this.framed(prompt.text, turn, prompt.images.length)}` },
      ],
    });
  }

  private beginTurn(turn: number): void {
    this.turnCount = turn;
    this.startedAt = Date.now();
    mkdirSync(this.opts.reportsDir, { recursive: true });
    writeFileSync(join(this.opts.reportsDir, ".turn"), String(turn));
  }

  private framed(text: string, turn: number, imageCount = 0): string {
    const dir = join(this.opts.reportsDir, String(turn));
    const rules = this.opts.rules?.() ?? "";
    const nudge = this.opts.nudge?.() ?? "";
    const standing = [rules, nudge].filter((value) => value !== "").join("\n\n");
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
      `not. Which of those this turn is, is your call.\n` +
      `If this turn takes more than a couple of steps, keep a checklist at ` +
      `${join(dir, "plan.json")} - {"steps":[{"text":"...","state":"todo|doing|done"}]} - ` +
      `and update it as you go. It is the only way the developer can see where ` +
      `you have got to while you work.\n\n${standingBlock}${attached}${text}`;
  }

  private endTurn(message: RpcMessage): void {
    const stopReason = typeof message.result?.stopReason === "string" ? message.result.stopReason : "error";
    const reply = this.reply;
    const result: ResultEvent = {
      type: "result",
      subtype: stopReason,
      is_error: Boolean(message.error) || !CLEAN_STOP_REASONS.has(stopReason),
      session_id: this.sessionId!,
      result: reply,
      // Devin bills in ACUs and ACP has no documented per-turn dollar cost.
    };
    this.running = false;
    this.startedAt = null;
    this.promptRequestId = null;
    if (this.queued.length > 0) {
      const next = folded(this.queued);
      this.queued = [];
      this.running = true;
      this.dispatch(next);
    }
    if (reply) this.emit("reply", reply);
    this.emit("turn-end", result);
  }
}
