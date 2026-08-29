import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  LineDecoder, userMessageLine, isResultEvent, activityLine, replyText, contextFrom,
  generationIdFrom, answeringModelFrom,
} from "./stream-codec.js";
import type { Context } from "../shared/context-window.js";
import type { Attachment } from "../shared/types.js";
import { buildSettings } from "./gates/settings.js";
import { credentialEnv } from "./anthropic-key.js";
import { sessionEnv as openRouterEnv } from "./gemini.js";
import { ROLE_BRIEF, COST_AWARENESS_BRIEF, DEFAULT_ROLE, type Role } from "../shared/roles.js";

/** Enough for a refusal and a stack trace, not enough to hold a log file. */
const STDERR_KEPT = 4000;

/**
 * Several prompts arrived while one turn was running. Answering each as its
 * own turn would resend the whole conversation once per message instead of
 * once for the lot - exactly the cost holding them in a queue was supposed
 * to avoid, just paid out one turn later instead of immediately. So they are
 * folded into a single turn, in the order they arrived, rather than each
 * getting its own trip through the conversation so far.
 */
/**
 * The id the CLI is handed for `--session-id`/`--resume`, which it rejects
 * outright unless it is shaped like a UUID (`claude --help`: "must be a
 * valid UUID"). Reusing the bench id as-is after a clear collides with the
 * conversation already recorded under it ("Session ID already in use"), but
 * appending a plain `-N` suffix - the first fix tried here - breaks the
 * shape the CLI checks for and fails every clear with "Invalid session ID.
 * Must be a valid UUID." instead. Hashing the id with the clear count keeps
 * the result UUID-shaped and deterministic, so every turn on the same
 * cleared conversation resolves to the same id without colliding with the
 * one before it.
 */
function versionedSessionId(id: string, clearCount?: number): string {
  if (!clearCount) return id;
  const hash = createHash("sha256").update(`${id}:${clearCount}`).digest("hex");
  return [hash.slice(0, 8), hash.slice(8, 12), hash.slice(12, 16), hash.slice(16, 20), hash.slice(20, 32)]
    .join("-");
}

function compacted(prompts: string[]): string {
  const intro =
    "The developer sent these while you were still on the turn before this "
    + "one. Answer them together, as one turn, not one at a time:";
  return [intro, ...prompts.map((p, i) => `${i + 1}. ${p}`)].join("\n\n");
}

/** One prompt on its way to the CLI: what was typed, and what was attached. */
interface Prompt {
  text: string;
  images: Attachment[];
}

/**
 * Everything the queue is holding, as the single turn it will be sent as.
 *
 * The images of every queued prompt travel together, in the order they were
 * sent. They cannot be numbered into the text the way the prompts are - an
 * image block carries no caption - so the text says how many came with it,
 * which is the difference between an agent that knows it is looking at two
 * screenshots from two messages and one that guesses.
 */
function folded(prompts: Prompt[]): Prompt {
  if (prompts.length === 1) return prompts[0];

  const images = prompts.flatMap((p) => p.images);
  const texts = prompts.map((p) => (
    p.images.length === 0
      ? p.text
      : `${p.text}\n(with ${p.images.length === 1 ? "1 image" : `${p.images.length} images`}, in order, below)`
  ));
  return { text: compacted(texts), images };
}

export interface SessionOptions {
  id: string;
  label: string;
  worktree: string;
  reportsDir: string;
  hookCommand: string;
  pluginDir: string;
  model: string;
  /**
   * What kind of agent this is, which it is told at spawn.
   *
   * It used to reach the model picker and the roster row and stop there, so a
   * reviewer and an implementer were handed identical text and behaved
   * identically - choosing a role bought a cheaper model and a word on a row.
   */
  role?: Role;
  port: number;
  /** Where the cockpit answers, so a specialist can staff its own project. */
  cockpitUrl?: string;
  claudeBin?: string;
  /** Turns this specialist has already taken. A revived one keeps counting
   * from where it stopped; starting again at one overwrites its own past. */
  startTurn?: number;
  /** Pick up a session the CLI already has a transcript for, rather than
   * starting a new one. Used when a specialist outlives the daemon. */
  resume?: boolean;
  /** How many times the developer has cleared the context for this session. */
  clearCount?: number;
  /**
   * The developer's house rules, read fresh for every turn rather than
   * captured at spawn - a rule saved now has to reach the specialist already
   * running, and the framing is the only thing said again each turn.
   */
  rules?: () => string;
  /**
   * What to tell this specialist about its own context and spend this turn,
   * if anything. Read fresh per turn like `rules`, for the same reason: the
   * fact this reports - a conversation getting full, a bill getting large -
   * only exists once the specialist is already running, so it cannot live in
   * the system prompt fixed at spawn. Empty on almost every turn.
   */
  nudge?: () => string;
  /**
   * The developer's own Anthropic key, if the cockpit has one. Read at spawn
   * rather than captured: env is fixed for the life of a process, so a key
   * saved now reaches the specialists started after it and no others.
   */
  apiKey?: () => string | null;
  /**
   * Set when this specialist is answered by OpenRouter rather than Anthropic:
   * the key to authenticate with, and how much the model will actually hold.
   *
   * Resolved before the process is spawned rather than read here, because
   * refusing for want of a key belongs in the dialog the developer is still
   * looking at - not in a turn that dies two minutes later.
   */
  via?: { key: string; contextLength?: number | null };
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

  /** How full the conversation is, as of the last turn that finished. */
  get contextUsed(): Context | null {
    return this.context;
  }

  /**
   * The OpenRouter generation ids the last finished turn was answered under,
   * in the order they were first seen.
   *
   * One id per API request, and a turn makes as many requests as it makes
   * tool calls - so this has as many entries as `usage.iterations` on the
   * same result event, which is a cheap way to notice the parser has begun
   * missing some. Several consecutive assistant events repeat the same id,
   * which is why they are de-duplicated on the way in.
   *
   * A getter, in the manner of `contextUsed` and `turnTokens`, rather than a
   * payload on `turn-end`: the existing listeners take the raw result event
   * and would all have to change to read a wrapper.
   */
  get turnGenerationIds(): string[] {
    return this.lastGenerationIds;
  }

  /** Which models actually answered the last finished turn - the router's
   * real choices, not the id that was asked for. Usually one, but a turn that
   * spans a router's fallback can genuinely have been answered by two. */
  get turnAnsweredBy(): string[] {
    return this.lastAnsweredBy;
  }

  /**
   * The same two for a turn that is still running.
   *
   * For the turn that never ends. Killing a specialist mid-turn is not an
   * accident here - it is how the developer changes its model, changes its
   * role, clears its context or simply stops it - and the money those requests
   * cost was spent whatever happens next. Billing hangs off the result event,
   * and a killed turn never emits one, so every one of those was free as far
   * as the cockpit could tell.
   *
   * Live rather than frozen, because the point in time this is read at is the
   * process exiting, which is precisely when there is no snapshot to have
   * taken.
   */
  get runningTurn(): { ids: string[]; answeredBy: string[] } | null {
    if (this.startedAt === null) return null;
    return { ids: [...this.generationIds], answeredBy: [...this.answeredBy] };
  }

  /** Prompts waiting for the running turn to end. */
  private queued: Prompt[] = [];
  private running = false;
  private startedAt: number | null = null;
  private tokens = 0;
  private context: Context | null = null;
  /** What the running turn has been answered by so far. Cleared per turn by
   * `beginTurn`, exactly as `tokens` is: these belong to one turn's bill and
   * carrying them into the next would charge it twice. */
  private generationIds = new Set<string>();
  private answeredBy = new Set<string>();
  /** The same two, frozen at the moment a turn ended - which is what the
   * getters expose. See `consume` for why the live sets are not safe to read
   * from a `turn-end` listener. */
  private lastGenerationIds: string[] = [];
  private lastAnsweredBy: string[] = [];
  private lastStderr = "";

  /** Spawn the process and wait. A specialist with nothing to do costs
   * nothing: `claude -p` blocks on stdin until a prompt arrives. */
  open(): void {
    if (this.child) throw new Error("session already started");

    const bin = this.opts.claudeBin ?? "claude";
    const settings = JSON.stringify(buildSettings({ hookCommand: this.opts.hookCommand }));
    // A specialist answered by OpenRouter is not talking to Anthropic, so an
    // Anthropic credential buys it nothing - and costs it something: setting
    // ANTHROPIC_API_KEY to a Claude key makes the CLI drop the claude.ai
    // login it would otherwise use, which turns off connectors. Its key is
    // the OpenRouter one instead, carried in `via`.
    const via = this.opts.via;
    const apiKey = via ? null : (this.opts.apiKey?.() ?? undefined);

    // --verbose is not optional: claude -p with stream-json exits without it.
    const args = [
      "-p",
      "--verbose",
      "--input-format", "stream-json",
      "--output-format", "stream-json",
      ...(this.opts.resume
        ? ["--resume", versionedSessionId(this.opts.id, this.opts.clearCount)]
        : ["--session-id", versionedSessionId(this.opts.id, this.opts.clearCount)]),
      "--name", this.opts.label,
      // Verbatim, whichever kind it is. An Anthropic alias the CLI resolves
      // itself; an OpenRouter id it does not recognise and passes straight
      // through to the endpoint, which is exactly what is wanted.
      "--model", this.opts.model,
      "--permission-mode", "acceptEdits",
      // Who this agent is, said once rather than on every turn.
      //
      // The system prompt is the right channel for a standing fact: it is
      // fixed for the life of the process, which is exactly what a role is,
      // and it does not cost tokens again on turn forty. House rules go in
      // the framing instead because those are read fresh each turn - a rule
      // saved now has to reach a specialist already running, and a role
      // cannot change without a restart anyway.
      "--append-system-prompt",
      `${ROLE_BRIEF[this.opts.role ?? DEFAULT_ROLE]}\n\n${COST_AWARENESS_BRIEF}`,
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
        // What `bench new` needs to decide whether a child it opens should
        // inherit this model: only true when this is itself an auto router.
        BENCH_SELF_MODEL: this.opts.model,
        PORT: String(this.opts.port),
        // What the `bench` command needs to find the cockpit. The token is
        // deliberately not here: the command reads it from ~/.bench/token so
        // it never has to appear on a command line, where `ps` would show it
        // to everything else on the machine.
        BENCH_URL: this.opts.cockpitUrl,
        // Only when there is one. Spreading nothing leaves whatever the
        // daemon was started with intact - a bench that has no key of its
        // own must not take away the one already in the environment.
        // A setup-token is an OAuth token and the CLI reads those from their
        // own variable; put one in ANTHROPIC_API_KEY and it is a key the API
        // has never issued.
        // If apiKey is explicitly null (parked), we must explicitly set both
        // variables to "none" or delete them from the spawned environment
        // so that any real environment variables in the daemon process are
        // not inherited by the spawned process. Unless it is explicitly undefined
        // (meaning no custom key was ever supplied/attempted, e.g., in a default
        // bench without any key set, where we want to let the environment leak).
        ...(apiKey !== undefined && apiKey !== null
          ? credentialEnv(apiKey)
          : apiKey === null
            ? { ANTHROPIC_API_KEY: "none", CLAUDE_CODE_OAUTH_TOKEN: "none" }
            : {}),
        // Everything OpenRouter needs, or nothing at all. Nothing at all is
        // the Anthropic case, and it has to leave the environment exactly as
        // it found it: a bench with no key of its own must not take away the
        // login the daemon was started with.
        ...(via ? openRouterEnv({ ...via, id: this.opts.id, cockpitUrl: this.opts.cockpitUrl }) : {}),
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
    // An EventEmitter with no "error" listener rethrows, so a process that
    // fails to spawn, or a pipe written to just after the process went, would
    // reach the top of the daemon and end it. Both are the child's problem
    // and neither should be the bench's.
    this.child.on("error", (error) => {
      this.lastStderr = (this.lastStderr + String(error)).slice(-STDERR_KEPT);
    });
    this.child.stdin.on("error", () => {
      // Writing to a stopped specialist. `close` is already on its way and
      // reports what happened; there is nothing to add here.
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
  send(text: string, images: Attachment[] = []): void {
    this.enqueue({ text, images });
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
  private enqueue(prompt: Prompt): void {
    if (!this.child) throw new Error("session not started");

    if (this.running) {
      // A turn is in flight. Hold the prompt; `consume` dispatches it when
      // the running turn ends.
      this.queued.push(prompt);
      return;
    }

    // Idle: this prompt becomes the running turn immediately.
    this.running = true;
    this.dispatch(prompt);
  }

  /** Begin a turn and hand it to the CLI. Only ever called for a turn that
   * starts now, so the framing matches the markers the gate reads. */
  private dispatch(prompt: Prompt): void {
    const turn = this.turnCount + 1;
    this.beginTurn(turn);
    this.child!.stdin.write(
      userMessageLine(this.framed(prompt.text, turn, prompt.images.length), prompt.images),
    );
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
    this.generationIds.clear();
    this.answeredBy.clear();
    mkdirSync(this.opts.reportsDir, { recursive: true });
    writeFileSync(join(this.opts.reportsDir, ".turn"), String(turn));
  }

  private framed(text: string, turn: number, imageCount = 0): string {
    const dir = join(this.opts.reportsDir, String(turn));
    const rules = this.opts.rules?.() ?? "";
    const nudge = this.opts.nudge?.() ?? "";
    // House rules and the context/spend nudge sit between the mechanics and
    // the ask: standing instructions first, then what is wanted now, so the
    // nearest thing to the prompt is the prompt. The nudge comes after rules
    // rather than before - it is fresher and rarer, so it belongs closer to
    // the thing it is actually about to affect.
    const standing = [rules, nudge].filter((s) => s !== "").join("\n\n");
    const standingBlock = standing === "" ? "" : `${standing}\n\n`;
    // An image block arrives with nothing saying where it came from, and an
    // agent that is not told reads it as having appeared out of nowhere -
    // observed doing exactly that when the format was first tried. This is
    // the caption the content array has no room for.
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

  private consume(chunk: string): void {
    for (const event of this.decoder.push(chunk)) {
      const line = activityLine(event);
      if (line) this.emit("activity", line);

      // Which OpenRouter requests answered this turn, and what actually
      // answered them. Sets, because one API request produces several
      // consecutive assistant events that all repeat its id - counting them
      // as separate requests would bill the developer once per paragraph.
      const generation = generationIdFrom(event);
      if (generation) this.generationIds.add(generation);
      const answerer = answeringModelFrom(event);
      if (answerer) this.answeredBy.add(answerer);

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
        // How full the conversation is now. Kept rather than emitted on its
        // own: it changes once a turn, and turn-end is that moment.
        this.context = contextFrom(event) ?? this.context;

        // Freeze what the turn was answered under, here, before anything
        // else in this block can run.
        //
        // The live sets are cleared by `beginTurn`, and the next queued turn
        // is dispatched a few lines below - before `turn-end` is emitted. So
        // a getter reading the live sets would hand the billing code an empty
        // one precisely when a second prompt was already waiting: the turn
        // that cost the most attention would be the one that appeared free.
        // The listener is async as well, and can read the getter several
        // awaits later, by which time a third turn may be under way. Neither
        // can touch a copy taken now.
        this.lastGenerationIds = [...this.generationIds];
        this.lastAnsweredBy = [...this.answeredBy];

        // The turn that just finished releases the markers to the next
        // queued turn, which only now becomes the running one. Everything
        // waiting goes together, as one turn - not one each, which is how a
        // developer typing three quick follow-ups used to cost three resends
        // of the whole conversation instead of one.
        this.running = false;
        this.startedAt = null;
        if (this.queued.length > 0) {
          const next = folded(this.queued);
          this.queued = [];
          this.running = true;
          this.dispatch(next);
        }

        if (reply) this.emit("reply", reply);
        this.emit("turn-end", event);
      }
    }
  }
}
