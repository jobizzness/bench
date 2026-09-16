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
 * How long a running turn may go without a single message from the agent -
 * a `session/update` of any kind, an inbound request, anything on the wire -
 * before it is declared stalled (#116). Keyed on silence since the agent's
 * last word, not on the turn's total duration: driving the real binary
 * showed `usage_update` alone arriving once at turn start and again at every
 * tool-call boundary, so a live turn keeps talking and a flat deadline would
 * only end up punishing a long but healthy one.
 */
const DEFAULT_STALL_TIMEOUT_MS = 60_000;

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
  /** Overrides `DEFAULT_STALL_TIMEOUT_MS`. Only ever set by tests. */
  stallTimeoutMs?: number;
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

/**
 * Devin's `Usage` struct, read off `session/prompt`'s result.
 *
 * Confirmed by driving the real binary (#115): the result carries
 * `{totalTokens, inputTokens, outputTokens, cachedReadTokens}`. Static
 * analysis of the shipped binary's string table turned up two more sibling
 * fields on the same struct, `thoughtTokens` and `cachedWriteTokens`, kept
 * here as well since they cost nothing to carry when present.
 *
 * This is the conversation's cumulative totals as of the moment the turn
 * ended, not the turn's own - a two-turn capture on #115 showed turn two's
 * `totalTokens` was the whole conversation so far (11762), not what turn two
 * itself spent (45). Carried onto the `ResultEvent` labelled as exactly
 * that: see `endTurn`. `turnTokens` below does the subtraction this field
 * does not.
 *
 * This is *not* the shape of a `usage_update` notification - see
 * `usageUpdateFrom` below, which is a different struct entirely and was the
 * first guess this file got wrong.
 */
function resultUsageFrom(value: unknown): Record<string, number> | null {
  if (!value || typeof value !== "object") return null;
  const usage = value as Record<string, unknown>;
  const totalTokens = usage.totalTokens;
  if (typeof totalTokens !== "number" || !Number.isFinite(totalTokens)) return null;
  const out: Record<string, number> = { totalTokens };
  for (const key of ["inputTokens", "outputTokens", "thoughtTokens", "cachedWriteTokens", "cachedReadTokens"]) {
    const found = usage[key];
    if (typeof found === "number" && Number.isFinite(found)) out[key] = found;
  }
  return out;
}

/**
 * A `usage_update` session/update notification, read off the wire by
 * driving a real Devin turn (#115 review comment) after the first guess
 * here - reading a `totalTokens` field, nested or flat - turned out wrong.
 * The captured payload, verbatim:
 *
 * ```json
 * {"sessionUpdate": "usage_update", "used": 10953, "size": 262000,
 *  "_meta": {"cognition.ai/inputTokens": 10920, "cognition.ai/outputTokens": 33}}
 * ```
 *
 * `used` is **the conversation's cumulative occupancy, not the turn's own
 * spend** - confirmed wrong the other way on the first round, by a second,
 * multi-turn capture on #115: across five tool calls in one turn `used`
 * moved ~700 (not a sum over those five requests), and it did not reset at
 * the next turn's boundary - turn two opened where turn one's last update
 * left off. `size` is the context window; the pair is exactly the
 * `{used, window}` `Context` wants and is read as-is, unadjusted, into
 * `contextUsed` - that reading was right from the start. `turnTokens`,
 * below, is what subtracts a per-turn baseline from `used`; this function
 * only reports what is actually on the wire.
 *
 * The `_meta` input/output split was seen on the wire too but is not read:
 * a second capture confirmed those are the *last request's* figures, not a
 * sum over the turn, so there is no per-turn total hiding in `_meta` either -
 * the result's own `usage` block already carries the authoritative
 * conversation-cumulative split once the turn ends, and nothing here needs a
 * mid-turn version of it. Seen and set aside, not unseen.
 */
function usageUpdateFrom(value: unknown): { used: number; size: number | null } | null {
  if (!value || typeof value !== "object") return null;
  const update = value as Record<string, unknown>;
  const used = update.used;
  if (typeof used !== "number" || !Number.isFinite(used)) return null;
  const size = update.size;
  return { used, size: typeof size === "number" && Number.isFinite(size) ? size : null };
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
  /** This turn's own token spend - `used` minus `turnStartUsed`, never
   * `used` itself, which is the whole conversation. Cleared by `beginTurn`,
   * exactly as `ClaudeSession.tokens` is - it belongs to one turn's count
   * and carrying it into the next would double it. */
  private tokens = 0;
  /** How full the conversation is, off the same notification. Kept rather
   * than cleared by `beginTurn`, exactly as `ClaudeSession.context` is: it
   * changes once a turn brings new usage, not once a turn starts. */
  private context: Context | null = null;
  /**
   * `used` as of the moment this turn began - the baseline `turnTokens`
   * subtracts from every `used` this turn reports, so a turn's own spend
   * doesn't read as the conversation's total. Set in `beginTurn` from
   * `this.context.used`, the last cumulative figure known.
   *
   * `null` when no baseline is known yet: a session resumed from a prior
   * process starts with no memory of what `used` was before this instance's
   * first `usage_update` arrives, so its first turn cannot honestly compute
   * a delta - `used` itself might already be the whole prior conversation.
   * A fresh, un-resumed session has no such gap; its baseline is 0, a real
   * fact (a new conversation starts empty), not a guess. While the baseline
   * is unknown, `turnTokens` simply does not move for that one turn rather
   * than report the conversation's size wearing a turn counter's label -
   * see #115 round 3. The turn after resolves it: by the next `beginTurn`,
   * `this.context.used` is set from this turn's own notifications.
   */
  private turnStartUsed: number | null = null;
  /** The last moment any message - notification, inbound request, or
   * response - arrived from the agent while a turn was running. Armed by
   * `beginTurn`, read by `checkStall`. `null` when no turn is running. */
  private lastMessageAt: number | null = null;
  private stallCheckTimer: ReturnType<typeof setInterval> | null = null;
  private readonly stallTimeoutMs: number;

  constructor(private readonly opts: DevinSessionOptions) {
    super();
    this.turnCount = opts.startTurn ?? 0;
    this.firstPrompt = opts.resumeSessionId === undefined;
    this.stallTimeoutMs = opts.stallTimeoutMs ?? DEFAULT_STALL_TIMEOUT_MS;
  }

  get turnStartedAt(): string | null {
    return this.startedAt === null ? null : new Date(this.startedAt).toISOString();
  }

  // This turn's own spend: `used` minus the baseline `used` was at when the
  // turn began (`turnStartUsed`), fed live from `usage_update` and frozen at
  // the same subtraction against the result's own cumulative `totalTokens`
  // when the turn ends. Never `used` itself - that is the whole
  // conversation, confirmed by a two-turn capture on #115 round 3. This is
  // what the roster's live token count reads.
  get turnTokens(): number { return this.tokens; }

  get turn(): number { return this.turnCount; }

  // `used`/`size` off the same `usage_update` notification - see
  // `usageUpdateFrom` for the captured payload this is read from. Null until
  // the first `usage_update` of the session arrives, then kept rather than
  // cleared per turn: see `context` above for why.
  get contextUsed(): Context | null { return this.context; }

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
      this.disarmStallWatchdog();
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
    // Any word from the agent counts as evidence the turn is alive - reset
    // the silence clock before doing anything else with the message. Only
    // meaningful while a turn is actually running; harmless no-op otherwise.
    if (this.running) this.lastMessageAt = Date.now();

    // `method` is what tells a notification or an agent-initiated request
    // apart from a response to one of *our* requests - a response never
    // carries one. Checking it first, rather than falling through to the
    // `message.id === this.xRequestId` chain below, is what #116 found
    // missing: an inbound request's `id` is the agent's own counter, not
    // ours, so it could only ever coincide with one of ours by chance - and
    // when it didn't, the message matched nothing and was silently dropped,
    // forever, with no response ever written back.
    if (message.method !== undefined) {
      if (message.method === "session/update") {
        this.update(message.params?.update);
        return;
      }
      if (message.id !== undefined) this.handleInboundRequest(message.id, message.method, message.params);
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

  /**
   * A JSON-RPC request from the agent to us, as opposed to a notification -
   * it carries an `id` it expects an answer on. `session/request_permission`
   * is the one confirmed real method in the binary's table (#116); the
   * default session mode is `accept-edits`, so most edits never reach here,
   * but anything that mode doesn't auto-approve will ask, and used to get no
   * answer at all. Deciding Bench's permission *policy* is out of scope
   * (#116) - this answers with whichever option the agent itself labelled
   * as an "allow", so the reply agrees with the mode already in effect
   * rather than picking a policy of its own. Anything else gets a
   * `-32601 Method not found` so the agent fails fast instead of waiting on
   * a reply that will never come.
   */
  private handleInboundRequest(id: number, method: string, params: Record<string, unknown> | undefined): void {
    if (method === "session/request_permission") {
      this.write({ jsonrpc: "2.0", id, result: { outcome: this.permissionOutcome(params) } });
      return;
    }
    this.write({ jsonrpc: "2.0", id, error: { code: -32601, message: `Bench does not handle ${method}` } });
  }

  private permissionOutcome(params: Record<string, unknown> | undefined): { outcome: string; optionId?: string } {
    const options = params?.options;
    if (Array.isArray(options)) {
      for (const option of options) {
        if (!option || typeof option !== "object") continue;
        const { kind, optionId } = option as Record<string, unknown>;
        if (typeof kind === "string" && kind.startsWith("allow") && typeof optionId === "string") {
          return { outcome: "selected", optionId };
        }
      }
    }
    // No allow option on offer, or a shape nothing here recognizes - a
    // defined "no selection was made" outcome, not a guess at one.
    return { outcome: "cancelled" };
  }

  private armStallWatchdog(): void {
    this.disarmStallWatchdog();
    this.lastMessageAt = Date.now();
    // Checked well inside the timeout window rather than once at the
    // deadline, so a short `stallTimeoutMs` in tests still resolves quickly.
    const intervalMs = Math.max(25, Math.floor(this.stallTimeoutMs / 4));
    this.stallCheckTimer = setInterval(() => this.checkStall(), intervalMs);
    this.stallCheckTimer.unref?.();
  }

  private disarmStallWatchdog(): void {
    if (this.stallCheckTimer) {
      clearInterval(this.stallCheckTimer);
      this.stallCheckTimer = null;
    }
  }

  private checkStall(): void {
    if (this.lastMessageAt === null) return;
    if (Date.now() - this.lastMessageAt < this.stallTimeoutMs) return;
    this.disarmStallWatchdog();
    const seconds = Math.round(this.stallTimeoutMs / 1000);
    this.lastStderr = (this.lastStderr
      + `\nDevin ACP went silent for ${seconds}s mid-turn - no session/update, no result. Treating the turn as stalled.`
    ).slice(-STDERR_KEPT);
    this.stop();
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
    if (update.sessionUpdate === "usage_update") {
      const usage = usageUpdateFrom(update);
      if (usage === null) return;
      let progressed = false;
      // Only when a baseline for this turn is known - see `turnStartUsed`.
      // Without one, `used` is indistinguishable from the whole
      // conversation, and reporting it as this turn's spend is the exact
      // defect #115 round 3 found.
      if (this.turnStartUsed !== null) {
        const spent = Math.max(0, usage.used - this.turnStartUsed);
        if (spent > this.tokens) {
          this.tokens = spent;
          progressed = true;
        }
      }
      if (usage.size !== null) {
        this.context = { used: usage.used, window: usage.size };
        progressed = true;
      }
      if (progressed) this.emit("progress");
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
    this.tokens = 0;
    this.armStallWatchdog();
    // `this.context.used` is the last cumulative figure this instance has
    // actually seen - accurate as a baseline whether it came from this
    // turn's predecessor or an earlier one. Only genuinely unknown on a
    // resumed session's first turn, before any `usage_update` of this
    // instance's own has arrived - see `turnStartUsed`. A fresh session has
    // no prior conversation to misreport, so 0 is correct, not a guess.
    this.turnStartUsed = this.context?.used ?? (this.opts.resumeSessionId ? null : 0);
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
    this.disarmStallWatchdog();
    const stopReason = typeof message.result?.stopReason === "string" ? message.result.stopReason : "error";
    const reply = this.reply;
    // The result's own cumulative count is authoritative over whatever
    // `usage_update` last reported, but it is still the whole conversation,
    // not this turn - subtract the same baseline `turnTokens` has been
    // subtracting all turn, so the frozen figure agrees with the live one.
    const usage = resultUsageFrom(message.result?.usage);
    if (usage && this.turnStartUsed !== null) {
      this.tokens = Math.max(0, usage.totalTokens - this.turnStartUsed);
    }
    const result: ResultEvent = {
      type: "result",
      subtype: stopReason,
      is_error: Boolean(message.error) || !CLEAN_STOP_REASONS.has(stopReason),
      session_id: this.sessionId!,
      result: reply,
      ...(usage ? { usage } : {}),
      // No dollar or ACU figure is on this wire. Confirmed twice over: static
      // analysis of the shipped binary (#115) found a `cognition.ai/
      // turn_stats` extension notification method and internal fields named
      // `committed_acu_cost` / `committed_credit_cost`, but a real captured
      // `cognition.ai/turn_stats` payload (#115 review comment) carried only
      // `responseDimensions` for input/output/cached tokens and an
      // agent-message count - no ACU, no dollars. Left unset rather than
      // guessed: see #117, filed for if that ever changes.
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
