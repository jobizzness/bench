import { EventEmitter } from "node:events";
import { mkdir, access } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { loadConfig } from "./config.js";
import { createServer, type SessionRegistryLike } from "./server.js";
import { createWorktree, currentBranch, excludeBenchDir, inspectWorktree, removeWorktree } from "./worktree.js";
import { bootstrapWorktree, BootstrapError } from "./bootstrap.js";
import { ClaudeSession } from "./claude-session.js";
import { existsSync } from "node:fs";
import { latestReportSeq, findReport, latestTurn } from "./reports.js";
import { SessionStore } from "./store.js";
import { appendActivity } from "./activity.js";
import { resolveTurnOutcome } from "./turn-outcome.js";
import { appendEntry, readThread } from "./thread.js";
import { writeClearContextReport } from "./clear-report.js";
import { answeredReportSeq } from "./answered.js";
import { asRole, isRole, type Role } from "../shared/roles.js";
import { modelForRole } from "../shared/role-models.js";
import { labelIsUsable } from "../shared/slug.js";
import { houseRules, readSettings, writeSettings, NO_SETTINGS, type Settings } from "./settings.js";
import { keyHint } from "./anthropic-key.js";
import { catalogue, isOpenRouterModel, settledCostOfTurn, type Listed } from "./gemini.js";
import { describeOrigin, type Origin } from "./env-file.js";
import { writeParked } from "./key-park.js";
import { isModelId, modelLabel } from "../shared/models.js";
import type { RosterRow, SessionStatus, Spend, StoredAttachment } from "../shared/types.js";
import { costOfTurn, type Price, type TurnShape } from "../shared/cost.js";
import { costFrom, shapeFrom } from "./stream-codec.js";
import type { ResultEvent } from "./stream-codec.js";
import { TurnLog } from "./turns.js";
import { Ledger, type Total } from "./ledger.js";
import { nudgeFor, type NudgeState } from "../shared/nudge.js";

interface Entry {
  row: RosterRow;
  reportsDir: string;
  threadPath: string;
  session: ClaudeSession | null;
  alive: boolean;
  /** Enough to bring the specialist back after the daemon has restarted. */
  worktree: string;
  branch: string;
  /** False when the specialist works in the project checkout itself. */
  isolated: boolean;
  /** Whether the CLI has a conversation to resume. See SessionRecord. */
  resumable: boolean;
  /** Turns already taken, read from disk when the roster is restored. */
  turnsTaken: number;
  /** The developer ended this turn, so the exit is a decision not a crash. */
  stopping?: boolean;
  /**
   * Why, when it was not simply "stop".
   *
   * Moving a specialist to another model also has to let the process go, and
   * a row that says "stopped by you" for that is a row that misreports a
   * thing the developer did not do.
   */
  stoppedBecause?: string;
  model: string;
  port: number;
  /** The specialist whose `bench new` opened this tab, if one did. Persisted:
   * the roster nests a child under its opener, and the nesting has to survive
   * a restart. It does double duty before the first turn, where it is also how
   * the daemon knows to hold a sender's message for dispatch - but that part
   * cannot outlive a restart anyway (see `resumable`), which is why it used to
   * be held in memory only. */
  createdBy: string | null;
  /** Whether the held first message has ever been released to the process.
   * Turn count alone used to stand in for this, which held every message -
   * not just the first - back onto `pendingDispatch` for as long as the tab
   * had zero completed turns. A tab that crashed before finishing its first
   * turn then had a "retry" nudge silently overwrite the real brief on every
   * subsequent `bench tell`, since it looked exactly like a fresh tab each
   * time. Not persisted, on the same reasoning as `resumable`: guessed from
   * the thread on restore, since a delivered message is exactly what leaves
   * one. */
  dispatched: boolean;
  /** What an agent told this tab, waiting on the developer to dispatch it. */
  pendingDispatch: string | null;
  /** Any images that came with it. Empty on every held message bench has seen
   * - `bench tell` sends text - but held separately from the text so that
   * stays true by construction rather than by luck. */
  pendingImages: StoredAttachment[];
  /** The worst context tone, and whether the spend threshold, this
   * specialist has already been told about. Not on the row: the developer
   * already sees the numbers themselves on the roster, this is only bench's
   * own memory of what the agent has been told. */
  nudged: NudgeState;
  /** How many times the developer has cleared the conversation's context. */
  clearCount?: number;
  /** Precompiled summary of previous context, injected on the next prompt. */
  threadSummary?: string | null;
}

export class SessionRegistry extends EventEmitter implements SessionRegistryLike {
  private entries = new Map<string, Entry>();
  private readonly store: SessionStore;
  /** The shape of the last twenty turns, whoever ran them. What makes "a turn
   * like yours" a claim about this bench rather than about a brochure. */
  private readonly turns: TurnLog;
  /**
   * Every turn this bench has paid for, kept where closing a tab cannot reach
   * it. The `spend` field on a specialist's record goes when the record does,
   * which made the ordinary end of a piece of work also the end of knowing
   * what it cost.
   */
  private readonly ledger: Ledger;
  /**
   * Held in memory as well as on disk because the framing is built
   * synchronously, at the instant a turn starts. Saving updates both, so a
   * rule written now is in the next turn of every specialist, including the
   * ones already running.
   */
  private settings: Settings = NO_SETTINGS;
  /**
   * The developer's own Anthropic key, when they have given one.
   *
   * In memory and nowhere else. It overrides a login the daemon already has,
   * and an override that survives a restart is one you stop knowing about -
   * so it lasts exactly as long as the daemon that was told it.
   */
  private apiKey: string | null = null;
  /** Where that key came from, so the cockpit can say rather than only show
   * its last four characters. */
  private apiKeyOrigin: Origin = { from: "settings" };

  /**
   * Whether that key is the one being handed out.
   *
   * Off is parked, not gone: switching between your own key and the machine's
   * login is a thing you do several times in an afternoon, and a switch that
   * forgets the key makes you paste it again every time.
   */
  private apiKeyOn = true;

  /**
   * The developer's OpenRouter key, for specialists run on anybody other than
   * Anthropic. In memory and nowhere else, the same rule the Anthropic key
   * follows: an override kept in a file is one you forget you set.
   */
  private routerKey: string | null = null;
  private routerKeyOrigin: Origin = { from: "settings" };

  /** The `.env` files that were looked in at startup, in the order they were
   * consulted. Reported so "Bench is not reading my file" is a question with
   * an answer. */
  private envSearched: string[] = [];

  /** The catalogue, once fetched. OpenRouter serves several hundred models
   * and the list changes rarely, so it is read once and kept rather than
   * fetched every time the picker opens. */
  private models: Listed[] | null = null;

  constructor(private readonly config: ReturnType<typeof loadConfig>) {
    super();
    this.store = new SessionStore(config.home);
    this.turns = new TurnLog(config.home);
    this.ledger = new Ledger(config.home);

    // Both keys, if the developer already wrote them down somewhere. Found
    // by loadConfig(), which is the file allowed to read the world - so a
    // registry built for a test finds nothing, rather than whatever happens
    // to be exported on the machine running it.
    const found = config.credentials;
    if (found !== undefined) {
      this.envSearched = found.searched;
      if (found.anthropic) {
        this.apiKey = found.anthropic.key;
        this.apiKeyOrigin = found.anthropic.origin;
      }
      if (found.router) {
        this.routerKey = found.router.key;
        this.routerKeyOrigin = found.router.origin;
      }
    }

    // The developer's own answer to "should this key be spent", from the
    // last time they gave one - an explicit answer always wins, parked or
    // not. Nobody has ever said the first time a key turns up this way: a
    // key typed into Settings turns itself on the moment it is saved, so
    // there is nothing to default here, but a key Bench found for itself in
    // the environment or a `.env` was never a choice the developer made, and
    // starts parked until they say otherwise in Settings.
    this.apiKeyOn = config.apiKeyParked === undefined ? this.apiKey === null : !config.apiKeyParked;
  }

  /**
   * What a specialist needs to be answered by OpenRouter, or undefined when
   * it is an Anthropic model and nothing has to change.
   *
   * Throws rather than returning undefined when the model needs a key there
   * is not - the message is the one the developer reads in the dialog, so it
   * says what to do rather than what failed.
   */
  private async viaFor(model: string): Promise<{ key: string; contextLength?: number | null } | undefined> {
    if (!isOpenRouterModel(model)) return undefined;
    if (this.routerKey === null) {
      throw new Error("no OpenRouter key - add one in Settings to run a specialist on this model");
    }
    // The window this model actually has. Best effort: if the catalogue
    // cannot be reached the specialist still starts, on the CLI's own
    // assumption, which is worse than the truth but better than nothing.
    const listed = (await this.catalogue().catch(() => [] as Listed[]))
      .find((m) => m.id === model);
    return { key: this.routerKey, contextLength: listed?.contextLength ?? null };
  }

  /**
   * The turn to price a model against, and how many real ones it came from.
   *
   * The count travels with it because a mean of two turns and a mean of
   * twenty are different claims, and the page drawing it has to be able to
   * say which one it is holding.
   */
  async typicalTurn(): Promise<{ shape: TurnShape | null; turns: number }> {
    return this.turns.typical();
  }

  /**
   * What this bench has spent, over its whole life or on one project.
   *
   * Read from the ledger rather than added up off the roster, because the
   * roster only holds specialists that still exist. Every total taken from
   * rows was a total of whoever had not been closed yet, which on this
   * machine meant leaving out seven tabs.
   */
  async spend(project?: string | null): Promise<Total> {
    return project
      ? this.ledger.total((entry) => entry.project === project)
      : this.ledger.total();
  }

  /**
   * What a new specialist of this role runs on.
   *
   * The developer's own answer if they have given one, the built-in table
   * otherwise - and whichever of the two this bench can actually reach. A
   * role whose model needs OpenRouter runs on its direct fallback when there
   * is no key, rather than silently on Opus at twenty times the price.
   */
  modelFor(role: Role): string {
    return modelForRole(role, {
      chosen: this.settings.roleModels[role],
      viaRouter: this.routerKey !== null,
    });
  }

  /** Every model OpenRouter serves, fetched once. */
  async catalogue(): Promise<Listed[]> {
    if (this.models === null) this.models = await catalogue();
    return this.models;
  }

  getSettings(): Settings {
    return this.settings;
  }

  /** What may be said about the key: that there is one, and which one. Never
   * the key - it goes to the daemon and does not come back. */
  apiKeyState(): { present: boolean; hint: string; enabled: boolean; origin: string; searched: string[] } {
    return this.apiKey === null
      ? { present: false, hint: "", enabled: this.apiKeyOn, origin: "", searched: this.envSearched }
      : {
        present: true,
        hint: keyHint(this.apiKey),
        enabled: this.apiKeyOn,
        // Where it came from, in words. A key that appears by itself is a
        // key nobody can account for, and the last four characters are not
        // an answer to "which key is that".
        origin: describeOrigin(this.apiKeyOrigin),
        searched: this.envSearched,
      };
  }

  /** The key to authenticate with, which is nothing at all while it is
   * switched off - callers should see a parked key exactly as they see no
   * key, and fall back to whatever the machine already has. */
  getApiKey(): string | null {
    return this.apiKeyOn ? this.apiKey : null;
  }

  setApiKey(key: string): void {
    this.apiKey = key;
    // Typed now beats written down earlier, for as long as this daemon runs.
    this.apiKeyOrigin = { from: "settings" };
    // Saving a key is asking for it to be used. Inheriting "off" from the key
    // it replaced would be a key that quietly does nothing - and that answer
    // has to be written down too, or the next restart parks a key the
    // developer just went to the trouble of typing.
    this.apiKeyOn = true;
    this.rememberParked(false);
  }

  /**
   * Park the key, or take it out of the car park.
   *
   * Written down, because this is the developer saying where their money
   * goes and a daemon restart is not them changing their mind.
   */
  setApiKeyEnabled(on: boolean): void {
    this.apiKeyOn = on;
    this.rememberParked(!on);
  }

  /** What may be said about the OpenRouter key: that there is one, and which
   * one. Never the key - it goes to the daemon and does not come back. */
  routerKeyState(): { present: boolean; hint: string; origin: string; searched: string[] } {
    return this.routerKey === null
      ? { present: false, hint: "", origin: "", searched: this.envSearched }
      : {
        present: true,
        hint: keyHint(this.routerKey),
        origin: describeOrigin(this.routerKeyOrigin),
        searched: this.envSearched,
      };
  }

  /** The OpenRouter key to authenticate with. Read by the credit meter's
   * source, which the server is deliberately unable to reach past. */
  getRouterKey(): string | null {
    return this.routerKey;
  }

  setRouterKey(key: string): void {
    this.routerKey = key;
    this.routerKeyOrigin = { from: "settings" };
  }

  /**
   * Let go of the OpenRouter key.
   *
   * Deliberately does not fall back to whatever the `.env` said. A Remove
   * button that puts the key straight back is a button that does nothing,
   * and the developer pressing it is telling this daemon to stop using that
   * key - a restart is how they say the opposite.
   */
  clearRouterKey(): void {
    this.routerKey = null;
    this.routerKeyOrigin = { from: "settings" };
  }

  /**
   * Let go of the Anthropic key, on the same terms.
   *
   * Throwing a key away is not the same as parking one, so the switch goes
   * back on: the next key the developer gives this bench is one they want
   * spent, and finding it arrived switched off would be a fault they go
   * looking for.
   */
  clearApiKey(): void {
    this.apiKey = null;
    this.apiKeyOrigin = { from: "settings" };
    this.apiKeyOn = true;
    this.rememberParked(false);
  }

  async saveSettings(input: unknown): Promise<Settings> {
    this.settings = await writeSettings(this.config.home, input);
    return this.settings;
  }

  /**
   * Rebuild the roster from disk. Nothing is spawned: a specialist costs
   * nothing until it is prompted, and the developer may only want to read
   * what an old one already wrote.
   */
  /**
   * A write to the index that nobody is waiting on.
   *
   * Nobody waiting is not nobody watching: an unawaited promise that rejects
   * is an unhandled rejection, and node ends the process for one of those.
   * A turn's context number failing to save is worth a line on stderr. It is
   * not worth six specialists.
   */
  /**
   * What the turn that just ended cost, added to what the specialist has run
   * up, and its shape kept for pricing other models against.
   *
   * Two accounts, and they are not interchangeable. A turn that went straight
   * to Anthropic is paid for by a subscription already bought, and the CLI's
   * own `total_cost_usd` is what it would have cost at list price - worth
   * knowing, not a bill. A turn answered by OpenRouter is money out of the
   * developer's balance today.
   *
   * That second one used to be priced from the catalogue, and the catalogue is
   * the wrong table. It quotes one provider; OpenRouter bills whichever
   * provider actually served the request, and the two are not close. Measured
   * against five hundred of this developer's own requests, the catalogue said
   * $7.02 where $10.24 had been charged - `deepseek/deepseek-v4-pro` was
   * quoted at $0.87 per million and served at about $1.60. No correction to
   * the arithmetic can fix that, because the number it is reading is not the
   * number being charged.
   *
   * So the true figure is fetched instead, one lookup per request the turn
   * made, and the estimate is what happens when that cannot be reached. Which
   * of the two a figure is travels with it into the ledger, because a total
   * that mixes settled charges with guesses and does not say so is a total
   * nobody can act on.
   */
  private async bill(
    entry: Entry,
    result: ResultEvent | undefined,
    turn: { ids: readonly string[]; answeredBy: readonly string[] },
  ): Promise<void> {
    const shape = result ? shapeFrom(result) : null;
    if (shape === null) return;

    // Every turn on the bench, whoever answered it. The picker prices a model
    // against the work this developer actually does, and a bench that only
    // sampled its cheap specialists would price everything against those.
    await this.turns.record(shape);

    if (!isOpenRouterModel(entry.row.model)) {
      // The CLI's own figure, from Anthropic's own table for an Anthropic
      // model. That one is right, and it is the only case where it is.
      const dollars = costFrom(result!);
      if (dollars === null) return;
      await this.charge(entry, dollars, "settled", "plan");
      return;
    }

    await this.billProxied(entry, shape, turn);
  }

  /**
   * What an OpenRouter turn really cost, or the best account of it available.
   *
   * Three outcomes, in descending order of how much they can be trusted, and
   * the ledger is told which one it got.
   */
  private async billProxied(
    entry: Entry,
    shape: TurnShape,
    turn: { ids: readonly string[]; answeredBy: readonly string[] },
  ): Promise<void> {
    const settled = this.routerKey !== null && turn.ids.length > 0
      ? await settledCostOfTurn(turn.ids, this.routerKey)
      : null;

    // Every request the turn made came back with a price. This is the bill.
    if (settled && settled.unpriced === 0 && settled.priced > 0) {
      await this.charge(entry, settled.dollars, "settled", "account", turn.answeredBy);
      return;
    }

    // Otherwise price it from the catalogue - against whatever actually
    // answered, not against what was asked for. Under an auto router the two
    // differ, and the requested one has no price at all: OpenRouter quotes
    // `openrouter/auto` as a negative sentinel, which is why a router turn
    // used to be recorded as nothing whatsoever, not even a turn.
    const estimate = await this.estimateOf(shape, entry.row.model, turn.answeredBy);

    // A part-settled sum is a floor on the bill rather than the bill, so it is
    // labelled a guess like any other. It is still the better guess whenever
    // it is the larger of the two: the catalogue has only ever been measured
    // reading low, so the higher of two under-estimates is the nearer one.
    const floor = settled?.priced ? settled.dollars : null;
    const dollars = floor === null ? estimate : Math.max(floor, estimate ?? 0);
    if (dollars === null) return;

    await this.charge(entry, dollars, "estimated", "account", turn.answeredBy);
  }

  /**
   * What a turn that was killed had already run up.
   *
   * There is no result event for one of these, so there is no token shape and
   * nothing for the catalogue to price - which is why every interrupted turn
   * used to cost nothing on the record. The requests still happened and were
   * still charged, and on a proxied specialist each one left an id behind, so
   * the bill is recoverable even though the estimate never was.
   *
   * Nothing to do on an Anthropic specialist: its cost arrives only in the
   * `total_cost_usd` of an event that will not be sent. That gap is named here
   * rather than papered over, because a zero would read as a fact.
   */
  private async billInterrupted(
    entry: Entry,
    running: { ids: string[]; answeredBy: string[] } | null,
  ): Promise<void> {
    if (running === null || running.ids.length === 0 || this.routerKey === null) return;

    const settled = await settledCostOfTurn(running.ids, this.routerKey);
    if (settled.priced === 0) return;

    // Part-settled is the ordinary case here rather than the exception: the
    // last request of an interrupted turn may never have completed, so it may
    // never have been billed either. What came back is what was charged.
    await this.charge(
      entry,
      settled.dollars,
      settled.unpriced === 0 ? "settled" : "estimated",
      "account",
      running.answeredBy,
    );
  }

  /**
   * The catalogue's account of a turn, priced against whichever model answered
   * it where that is known.
   *
   * The models that answered are tried before the one on the row because the
   * row's may be a router rather than a model. Where several answered - a
   * router that changed its mind mid-turn - the dearest is used: this is a
   * fallback that has already been measured reading low, and rounding it down
   * again is the wrong direction to be wrong in.
   */
  private async estimateOf(
    shape: TurnShape,
    asked: string,
    answeredBy: readonly string[],
  ): Promise<number | null> {
    const candidates = [...answeredBy, asked];
    let best: number | null = null;
    for (const model of candidates) {
      const cost = costOfTurn(shape, await this.priceOf(model));
      if (cost !== null && (best === null || cost > best)) best = cost;
    }
    return best;
  }

  /**
   * Put a turn's cost on the row and in the ledger.
   *
   * Both, because they answer different questions and only one of them
   * survives. The row is what the developer reads while the specialist is
   * alive; the ledger is what is left when they close the tab, which is the
   * ordinary end of a specialist's life and used to take the money with it.
   *
   * The ledger is written first. If only one of the two can happen, the one
   * that cannot be reconstructed is the one worth keeping - a row's total is
   * derivable from the ledger, and nothing derives the ledger from a row.
   */
  private async charge(
    entry: Entry,
    dollars: number,
    basis: "settled" | "estimated",
    billed: "plan" | "account",
    served: readonly string[] = [],
  ): Promise<void> {
    await this.ledger.record({
      at: new Date().toISOString(),
      session: entry.row.id,
      label: entry.row.label,
      project: entry.row.project,
      model: entry.row.model,
      // Only where it says something the model above does not. On a router
      // this is the whole point - it is the only record anywhere of what the
      // router actually picked - and on a pinned model it is the same name
      // twice.
      ...(served.length > 0 && !(served.length === 1 && served[0] === entry.row.model)
        ? { served: [...served] }
        : {}),
      dollars,
      billed,
      basis,
    });

    const before = entry.row.spend;
    const spend: Spend = {
      dollars: (before?.dollars ?? 0) + dollars,
      turns: (before?.turns ?? 0) + 1,
      billed,
    };
    entry.row.spend = spend;
    await this.store.rememberSpend(entry.row.id, spend);
  }

  /** What the catalogue says this model charges. Unknown prices all round for
   * one it cannot reach, which costs a turn nothing rather than guessing. */
  private async priceOf(model: string): Promise<Price> {
    const listed = (await this.catalogue().catch(() => [] as Listed[])).find((m) => m.id === model);
    return listed?.price ?? { fresh: null, cacheWrite: null, cacheRead: null, out: null };
  }

  private remember(work: Promise<unknown>): void {
    void work.catch((error) => {
      process.stderr.write(`bench: could not update the specialist index: ${String(error)}\n`);
    });
  }

  /**
   * Write the parked flag down, and say so if it cannot be.
   *
   * Its own reporter rather than `remember`, because that one names the
   * specialist index and a developer reading "could not update the specialist
   * index" after touching the key switch would go looking in the wrong place.
   * The switch still works for this daemon either way; what is lost is only
   * that the next one will not know.
   */
  private rememberParked(parked: boolean): void {
    void writeParked(this.config.home, parked).catch((error) => {
      process.stderr.write(
        `bench: could not write down whether the key is parked, so a restart will forget: ${String(error)}\n`,
      );
    });
  }

  async restore(): Promise<void> {
    this.settings = await readSettings(this.config.home);

    for (const rec of await this.store.all()) {
      const worktreeGone = !existsSync(rec.worktree);
      // Read once and used twice: what has already been answered, and whether
      // this specialist has ever spoken.
      const thread = await readThread(join(rec.reportsDir, "thread.jsonl"));
      this.entries.set(rec.id, {
        reportsDir: rec.reportsDir,
        threadPath: join(rec.reportsDir, "thread.jsonl"),
        session: null,
        alive: false,
        worktree: rec.worktree,
        turnsTaken: await latestTurn(rec.reportsDir),
        // Records written before branches carried the session id named the
        // branch after the label.
        branch: rec.branch ?? `worktree-${rec.label}`,
        // Absent on every record written before the toggle existed, and all
        // of those had a worktree.
        isolated: rec.isolated ?? true,
        // Absent on records written before this was tracked. Rather than
        // guess, read it off the thread: a specialist with entries has taken
        // turns, and a turn is exactly what leaves the CLI a conversation to
        // resume. Guessing false is safe for the process and expensive for
        // the developer - it silently drops everything the specialist knows.
        resumable: rec.resumable ?? thread.length > 0,
        model: rec.model,
        port: rec.port,
        // Not persisted: whatever was pending before a restart cannot
        // survive one anyway, since the idle process it was waiting on is
        // gone too.
        createdBy: rec.createdBy ?? null,
        dispatched: thread.length > 0,
        pendingDispatch: null,
        pendingImages: [],
        nudged: rec.nudged ?? {},
        clearCount: rec.clearCount,
        row: {
          id: rec.id,
          label: rec.label,
          role: asRole(rec.role),
          branch: rec.branch ?? `worktree-${rec.label}`,
          isolated: rec.isolated ?? true,
          project: rec.project,
          model: rec.model,
          status: worktreeGone ? "crashed" : "awaiting_decision",
          detail: worktreeGone ? "worktree is gone" : "ready",
          latestReportSeq: await latestReportSeq(rec.reportsDir),
          // Derived from the thread rather than stored: the conversation
          // already records who spoke last, so it cannot drift.
          answeredReportSeq: answeredReportSeq(thread),
          startedAt: null,
          tokens: 0,
          context: rec.context ?? null,
          activity: [],
          spend: rec.spend ?? null,
          answeredBy: rec.answeredBy ?? null,
          createdBy: rec.createdBy ?? null,
          pendingPrompt: null,
          reasoningEffort: rec.reasoningEffort,
          broadcast: rec.broadcast ?? false,
        },
      });
    }
    this.emit("roster");
  }

  list(): RosterRow[] {
    return [...this.entries.values()].map((e) => e.row);
  }

  get(id: string): {
    reportsDir: string;
    threadPath: string;
    alive: boolean;
    revivable: boolean;
    /** What it runs on, which decides whether it can be sent an image. */
    model: string;
  } | null {
    const entry = this.entries.get(id);
    if (!entry) return null;
    return {
      reportsDir: entry.reportsDir,
      threadPath: entry.threadPath,
      alive: entry.alive,
      model: entry.model,
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
    /** What this agent is told it is, at spawn. Fixed for the life of the
     * process, which is why changing it lets the process go. */
    role: Role;
    port: number;
    resume?: boolean;
    clearCount?: number;
    startTurn?: number;
    /** Set for an OpenRouter model, already resolved. */
    via?: { key: string; contextLength?: number | null };
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
      role: opts.role,
      port: opts.port,
      resume: opts.resume,
      clearCount: opts.clearCount,
      cockpitUrl: `http://127.0.0.1:${this.config.port}`,
      claudeBin: this.config.claudeBin,
      startTurn: opts.startTurn,
      rules: () => houseRules(this.settings),
      nudge: () => this.nudgeTextFor(id),
      // Through the getter, not off the field: a parked key must reach the
      // process as no key at all, or the switch in Settings is a control
      // that moves and changes nothing.
      apiKey: () => this.getApiKey(),
      via: opts.via,
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

    session.on("activity", (line: string) => {
      syncProgress();
      const current = this.entries.get(id);
      if (current) {
        // A trail, not a single line: one tool name tells you what is
        // happening this instant, never where the turn has got to.
        current.row.activity = appendActivity(current.row.activity, line, new Date().toISOString());
      }
      this.update(id, "working", line);
    });
    session.on("exit", (code: number | null, stderr: string) => {
      const entry = this.entries.get(id);
      if (entry) {
        // Whatever the turn that was interrupted had already spent. Read
        // before anything else touches the session, because the reference is
        // dropped two lines below and this is the last moment it exists.
        this.remember(this.billInterrupted(entry, session.runningTurn));
        entry.alive = false;
        // Let go of it. A session whose process has gone refuses everything
        // sent to it, and holding the reference meant the next message took
        // the "already running" path and threw - which, inside a request
        // handler, took the whole daemon with it. Cleared, the next prompt
        // takes the revival path, which is what a stopped specialist is for.
        entry.session = null;
      }

      // A process that dies before finishing its first turn never flips
      // `resumable` (see markResumable), yet `--session-id` has already
      // claimed this id on disk - the CLI's own refusal here is proof of
      // that. Left alone, the next revive asks for `--session-id` again,
      // collides the same way, and the tab is crashed forever. The CLI has
      // told us the id is claimed, so believe it: mark resumable now so the
      // next attempt asks for `--resume` instead of repeating the collision.
      if (entry && !opts.resume && !entry.resumable && /already in use/i.test(stderr ?? "")) {
        entry.resumable = true;
        this.remember(this.store.markResumable(id));
      }

      // Asked for, not suffered. The specialist is still here and its next
      // prompt revives it from the last turn it finished.
      if (entry?.stopping) {
        entry.stopping = false;
        const because = entry.stoppedBecause ?? "stopped by you";
        entry.stoppedBecause = undefined;
        // Still holding a message nobody has sent yet, so that is still what
        // it is waiting on. Changing the model is the main thing the dispatch
        // modal is for and it stops the process to do it - landing on
        // "awaiting_decision" here took the held prompt off the roster
        // mid-choice, leaving no way to send or decline it.
        this.update(
          id,
          entry.pendingDispatch !== null ? "awaiting_dispatch" : "awaiting_decision",
          entry.pendingDispatch !== null ? "waiting on you to dispatch" : because,
        );
        return;
      }

      // The CLI's own words first: it refuses with a plain sentence, and that
      // sentence is the difference between a developer who knows what to do
      // and one looking at "process exited".
      const said = (stderr ?? "").split("\n").filter((l) => l.trim() !== "").pop();
      this.update(id, "crashed", said ?? (code === null ? "process exited" : `process exited (${code})`));
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

    session.on("turn-end", async (result: ResultEvent) => {
      const entry = this.entries.get(id);
      if (!entry) return;

      const seq = await latestReportSeq(reportsDir);
      const hasNewReport = seq !== null && seq !== entry.row.latestReportSeq;
      entry.row.latestReportSeq = seq;

      if (hasNewReport) {
        const report = await findReport(reportsDir, seq);
        const title = report ? report.decision.title : `Report ${seq}`;
        await appendEntry(entry.threadPath, {
          kind: "report",
          body: title,
          reportSeq: seq,
        });

        // A tab another specialist opened reports back to it, the same way a
        // report already wakes the developer - reusing that exact signal
        // rather than a second one, and only on a report: a plain reply stays
        // as quiet for the parent as it is for the developer. `send` is the
        // one path a message to a specialist ever takes, so a parent that
        // hasn't dispatched this tab yet still gets it held for review first.
        //
        // Sent as being from the child, which is what it is. Holding turns on
        // a sender being named - what the developer types is never held back
        // from the specialist they typed it to - so leaving it out would put
        // this straight into a parent that has itself never been dispatched,
        // which is the one case the holding was added for.
        if (entry.createdBy !== null) {
          const htmlPath = report?.htmlPath ?? join(reportsDir, String(seq), "report.html");
          this.send(
            entry.createdBy,
            `${entry.row.label} wrote a report: "${title}". Read ${htmlPath}, or bench tell ${entry.row.label} to answer it.`,
            entry.row.id,
          );
        }
      }

      // How full the conversation is now. Kept on disk as well as on the row:
      // a cockpit that has just started should be able to say whether a cold
      // specialist is worth reviving without prompting it first.
      const context = session.contextUsed;
      if (context) {
        entry.row.context = context;
        this.remember(this.store.rememberContext(id, context));
      }

      // Who actually answered, on a specialist running a router rather than a
      // model of its own. Empty on everything else - a model that answers for
      // itself has nothing to report here - so only written when there is
      // something to say.
      const answeredBy = session.turnAnsweredBy;
      if (answeredBy.length > 0) {
        entry.row.answeredBy = answeredBy;
        this.remember(this.store.rememberAnsweredBy(id, answeredBy));
      }

      // What the turn moved, and what that came to. Recorded here rather than
      // in the session because this is the only place that knows which
      // account answered - and the two are not the same kind of money.
      // Read here rather than inside `bill`, which is deliberately not
      // awaited: by the time it runs, a queued next turn may already have
      // started and be filling the session's own counters. The session
      // freezes these at turn-end for exactly this reason, but reading them
      // now keeps the dependency on that visible rather than assumed.
      this.remember(this.bill(entry, result, {
        ids: session.turnGenerationIds,
        answeredBy: session.turnAnsweredBy,
      }));

      // A turn has ended, so the CLI has written a conversation and the next
      // process can pick it up.
      if (!entry.resumable) {
        entry.resumable = true;
        this.remember(this.store.markResumable(id));
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

  /**
   * What to tell this specialist about its own context and spend this turn,
   * if anything - and remember that it was told, so the same crossing is not
   * repeated on turn forty.
   *
   * Read at dispatch time off the row, not the session: the row already
   * carries the context and spend as of the last turn that finished, which is
   * exactly what the next turn's framing should be reacting to.
   */
  private nudgeTextFor(id: string): string {
    const entry = this.entries.get(id);
    if (!entry) return "";

    const result = nudgeFor(entry.row.context, entry.row.spend, entry.nudged);
    if (!result) return "";

    entry.nudged = result.state;
    this.remember(this.store.rememberNudged(id, result.state));
    return result.text;
  }

  async create(input: {
    project: string;
    label: string;
    /** Empty means "whatever this role runs on" - see modelForRole. Every
     * caller that has an opinion sends one; the CLI, which has only a role,
     * does not. */
    model: string;
    /** What kind of agent this is. Anything unrecognised is a specialist. */
    role?: string;
    /** Default true: isolation is what a specialist is normally for. */
    isolated?: boolean;
    /** The specialist opening this tab with `bench new`, if any. Absent for
     * a tab the developer opened themselves, from the cockpit. */
    createdBy?: string;
    /** Model reasoning/thinking effort level. */
    reasoningEffort?: "none" | "low" | "medium" | "high";
  }): Promise<string> {
    const isolated = input.isolated ?? true;
    const role = asRole(input.role);
    const model = input.model === "" ? this.modelFor(role) : input.model;
    const reasoningEffort = input.reasoningEffort ?? this.settings.reasoningEffort ?? "medium";

    // Before anything is created. A model that needs an OpenRouter key and
    // has none is the developer's problem while they are still looking at the
    // dialog they asked from - not a row on the roster that provisioned a
    // worktree and then died on its first turn.
    const via = await this.viaFor(model);

    const id = randomUUID();
    const reportsDir = join(input.project, ".bench", "reports", id);

    this.entries.set(id, {
      reportsDir,
      threadPath: join(reportsDir, "thread.jsonl"),
      session: null,
      alive: false,
      worktree: "",
      branch: "",
      isolated,
      resumable: false,
      turnsTaken: 0,
      model,
      port: 0,
      createdBy: input.createdBy ?? null,
      dispatched: false,
      pendingDispatch: null,
      pendingImages: [],
      nudged: {},
      clearCount: 0,
      row: {
        id,
        label: input.label,
        role,
        branch: "",
        isolated,
        project: input.project,
        model,
        status: "provisioning",
        detail: isolated ? "creating worktree" : "opening the checkout",
        latestReportSeq: null,
        answeredReportSeq: null,
        startedAt: new Date().toISOString(),
        tokens: 0,
        context: null,
        activity: [],
        spend: null,
        answeredBy: null,
        createdBy: input.createdBy ?? null,
        pendingPrompt: null,
        reasoningEffort,
        // Off by default. See `setBroadcast` for what turning it on means.
        broadcast: false,
      },
    });
    this.emit("roster");

    try {
      await excludeBenchDir(input.project);
      // Without isolation the specialist works where the developer works: the
      // checkout itself, on whatever branch is already there. Nothing is
      // created, so nothing is Bench's to take away again.
      const { worktree, branch } = isolated
        ? await createWorktree(input.project, input.label, id)
        : { worktree: input.project, branch: await currentBranch(input.project) };
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
      entry.branch = branch;
      // The row is made before the worktree exists, so this is the first
      // moment there is a branch to name.
      entry.row.branch = branch;
      entry.port = port;
      this.attach(id, {
        label: input.label,
        worktree,
        model,
        role,
        port,
        via,
      });
      // The process waits. A specialist is given work by prompting it, not
      // by being created.
      await this.store.put({
        id, label: input.label, role, project: input.project, worktree, branch, reportsDir,
        model, port, createdAt: new Date().toISOString(), isolated,
        createdBy: input.createdBy ?? null, reasoningEffort,
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
  /** Bring a cold specialist back, on whatever backend it was made on. */
  private revive(id: string, entry: Entry, via: { key: string; contextLength?: number | null } | undefined): ClaudeSession {
    return this.attach(id, {
      label: entry.row.label,
      worktree: entry.worktree,
      model: entry.model,
      role: entry.row.role,
      port: entry.port,
      // Only ever resume a conversation that exists. Asking the CLI to
      // resume one that does not prints "No conversation found with session
      // ID" and exits before the prompt is ever read.
      resume: entry.resumable,
      clearCount: entry.clearCount,
      // Pick up the numbering where it stopped, or this turn writes over
      // the last one's report.
      startTurn: entry.turnsTaken,
      via,
    });
  }

  /**
   * @param from The specialist that sent this, when one did. Absent means the
   * developer, typing in the cockpit - and what the developer types is never
   * held back from the specialist they typed it to.
   */
  send(id: string, text: string, from?: string, images: StoredAttachment[] = []): void {
    const entry = this.entries.get(id);
    if (!entry) return;

    // A tab another specialist opened gets its first message held rather
    // than delivered, so the developer can read it - and change the model,
    // which costs nothing while the process is still the idle one this tab
    // was made with - before it actually runs. Gated on whether it has ever
    // been dispatched, not on turn count: a tab that crashes before its
    // first turn completes still has zero turns on every retry, and gating
    // on that instead would re-park (and silently overwrite) the real brief
    // behind whatever nudge sent the retry.
    if (from !== undefined && entry.createdBy !== null && !entry.dispatched) {
      entry.pendingDispatch = text;
      entry.pendingImages = images;
      entry.row.pendingPrompt = text;
      this.update(id, "awaiting_dispatch", "waiting on you to dispatch");
      return;
    }

    this.deliver(id, entry, text, images);
  }

  /** Release a held message, exactly as if it had just arrived. */
  async dispatch(id: string): Promise<void> {
    const entry = this.entries.get(id);
    if (!entry) throw new Error("no such specialist");
    const text = entry.pendingDispatch;
    if (text === null) throw new Error("nothing is waiting to be dispatched");
    const images = entry.pendingImages;
    entry.pendingDispatch = null;
    entry.pendingImages = [];
    entry.row.pendingPrompt = null;
    entry.dispatched = true;
    this.deliver(id, entry, text, images);
  }

  /** Discard a held message. The tab goes back to exactly its just-created
   * state - empty, waiting, as if `bench tell` had never been called. Bench
   * has no way to close a tab it did not open itself (see bench-roster), so
   * this is the whole of what a decline does. */
  decline(id: string): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    entry.pendingDispatch = null;
    entry.pendingImages = [];
    entry.row.pendingPrompt = null;
    this.update(id, "awaiting_decision", "ready");
  }

  /** The part of prompting a specialist that a held message also has to go
   * through once it is released: the same path `send()` always took. */
  private deliver(id: string, entry: Entry, text: string, images: StoredAttachment[] = []): void {
    // A specialist restored from disk has no process yet. Bring it back on
    // the first prompt, resuming the transcript the CLI still holds, so it
    // remembers what it was doing.
    // A specialist restored from disk has no process yet, and no worktree to
    // bring one back into is the end of it.
    if (!entry.session && !existsSync(entry.worktree)) {
      this.update(id, "crashed", "worktree is gone");
      return;
    }

    let promptText = text;
    if (entry.threadSummary) {
      promptText = `${entry.threadSummary}\n\n${text}`;
      entry.threadSummary = null;
    }

    // The thread keeps the reference, never the bytes - see storeAttachments.
    void appendEntry(entry.threadPath, {
      kind: "user",
      body: text,
      ...(images.length > 0
        ? { images: images.map(({ name, mediaType }) => ({ name, mediaType })) }
        : {}),
    });
    // Prompting a specialist is how a decision gets answered, so whatever
    // was on the table is answered now.
    entry.row.answeredReportSeq = entry.row.latestReportSeq;
    // The trail describes the turn in flight, so it starts empty.
    entry.row.activity = [];

    if (entry.session) {
      entry.session.send(promptText, images);
      this.update(id, "working", "starting");
      return;
    }

    // Cold, so this prompt revives it.
    //
    // A specialist that needs no proxy is revived here and now, exactly as it
    // always was. Only a proxied one has to wait, and it waits because the
    // proxy may not be up: a CLI pointed at a base URL nothing is listening
    // on retries with a doubling delay, so skipping the wait would turn a
    // stopped proxy into a specialist that hangs for two minutes.
    if (!isOpenRouterModel(entry.model)) {
      this.revive(id, entry, undefined);
      entry.session!.send(promptText, images);
      this.update(id, "working", "starting");
      return;
    }

    // Slow enough on a first run that saying nothing would read as a prompt
    // that went nowhere.
    this.update(id, "working", "waking up");
    void this.viaFor(entry.model).then(
      (via) => {
        this.revive(id, entry, via);
        entry.session!.send(promptText, images);
        this.update(id, "working", "starting");
      },
      (error: unknown) => {
        this.update(id, "crashed", error instanceof Error ? error.message : String(error));
      },
    );
  }

  /**
   * End the turn a specialist is in the middle of.
   *
   * The process goes; the specialist does not. Its worktree, its thread and
   * its reports are untouched, and the next prompt brings it back from the
   * last turn it finished - so what is lost is the turn in flight, which is
   * what the developer asked to lose.
   *
   * Marked before the kill so the exit is read as a decision rather than as
   * a crash. "Process exited" is what a specialist that fell over says, and
   * telling the developer that about something they just did themselves is
   * how a roster stops being believed.
   */
  /**
   * Rename a specialist.
   *
   * The label only; the branch and the worktree keep the names they were
   * given. Renaming those means moving a checked-out worktree and a branch
   * that may already be pushed, to change a string nobody reads except in
   * `git branch` - and the stage head shows the branch, so the two drifting
   * apart is visible rather than hidden.
   */
  rename(id: string, label: string): boolean {
    const entry = this.entries.get(id);
    if (!entry || !labelIsUsable(label)) return false;

    entry.row.label = label.trim();
    this.remember(this.store.rename(id, entry.row.label));
    this.emit("roster");
    return true;
  }

  /**
   * Put a specialist on a different model.
   *
   * The running process cannot be moved: `--model` is fixed at spawn, and so
   * is the base URL that decides who answers. So the change is recorded and
   * the process is let go of - the next prompt revives it on the new model,
   * resuming the same transcript, which is the path a cold specialist already
   * takes every time the daemon restarts.
   *
   * Lazy rather than eager on purpose. Restarting here would spend a turn's
   * startup on a decision the developer might still be thinking about, and a
   * specialist that is mid-turn would lose the turn.
   */
  async setModel(id: string, model: string): Promise<void> {
    const entry = this.entries.get(id);
    if (!entry) throw new Error("no such specialist");
    if (!isModelId(model)) throw new Error("not a model this bench offers");
    if (entry.model === model) return;

    // Before anything is recorded. Moving onto a provider with no key, or
    // with no way to run its proxy, fails here - while the developer is
    // still looking at the modal - rather than on the next prompt.
    await this.viaFor(model);

    entry.model = model;
    entry.row.model = model;
    this.remember(this.store.remodel(id, model));

    // A live process is now running the wrong model. Let it go; the next
    // prompt brings it back on the new one. Deliberately not `stop()`, which
    // means "the developer stopped this" and says so on the row.
    if (entry.session) {
      entry.stopping = true;
      entry.stoppedBecause = `moved to ${modelLabel(model)}`;
      entry.session.stop();
    } else {
      this.emit("roster");
    }
  }

  /** Change reasoning effort level. */
  async setReasoningEffort(id: string, reasoningEffort: "none" | "low" | "medium" | "high"): Promise<void> {
    const entry = this.entries.get(id);
    if (!entry) throw new Error("no such specialist");
    if (entry.row.reasoningEffort === reasoningEffort) return;

    entry.row.reasoningEffort = reasoningEffort;
    this.remember(this.store.setReasoningEffort(id, reasoningEffort));

    if (entry.session) {
      entry.stopping = true;
      entry.stoppedBecause = `changed reasoning effort to ${reasoningEffort}`;
      entry.session.stop();
    } else {
      this.emit("roster");
    }
  }

  /**
   * Change what kind of agent this is.
   *
   * The same shape as setModel, and for the same reason: the role reaches the
   * process as a system prompt, and a system prompt is fixed at spawn. So the
   * change is recorded and the running process is let go - the next prompt
   * revives it on the new role, resuming the same transcript.
   *
   * The model follows only when it was this role's own default and nobody
   * has said otherwise. A developer who went to the picker and chose Opus
   * meant Opus; moving them off it because they relabelled the tab would be
   * throwing away the more specific of two answers. But a tab that has simply
   * been taking whatever its role runs on should keep doing that, or changing
   * a reviewer to an implementer leaves it on the cheap model the review was
   * costed for.
   */
  async setRole(id: string, role: Role): Promise<void> {
    const entry = this.entries.get(id);
    if (!entry) throw new Error("no such specialist");
    // Checked here as well as at the route, because an unrecognised word
    // written onto the row is one that reaches the spawn, where it indexes
    // ROLE_BRIEF and hands the agent `undefined` as its whole system prompt.
    if (!isRole(role)) throw new Error("not a role this bench has");
    if (entry.row.role === role) return;

    const wasDefault = entry.model === this.modelFor(entry.row.role);
    entry.row.role = role;
    this.remember(this.store.reroute(id, role));

    // Before the role is announced: moving onto a model that needs a key
    // there is not should fail while the developer is still looking at the
    // dialog, not on the next prompt.
    if (wasDefault) {
      const next = this.modelFor(role);
      if (next !== entry.model) await this.setModel(id, next);
    }

    if (entry.session) {
      entry.stopping = true;
      entry.stoppedBecause = `now a ${role}`;
      entry.session.stop();
    } else {
      this.emit("roster");
    }
  }

  /**
   * Whether this specialist - and everything `bench new` opened underneath
   * it - may be mirrored to Firestore.
   *
   * Off by default, on one specialist at a time, and never inferred: see
   * "Broadcast decides what may be mirrored at all" in the design. Turning it
   * on carries every descendant `bench new` opened from this tab, because a
   * specialist and the researcher it spun up are one piece of work and
   * splitting them would mean broadcasting a parent whose findings cannot be
   * read. Turning it off does the same in reverse - a child left broadcast
   * after its parent stopped being reachable would be a leak, not a choice.
   *
   * This only changes the local flag. Deleting an already-mirrored
   * specialist's documents the moment broadcast goes off is the remote
   * bridge's job, reacting to the same `"roster"` event this emits - not
   * this method's, which has no idea whether remote is even on.
   */
  async setBroadcast(id: string, broadcast: boolean): Promise<void> {
    const entry = this.entries.get(id);
    if (!entry) throw new Error("no such specialist");

    const family = this.descendants(id);
    for (const member of [entry, ...family]) {
      if (member.row.broadcast === broadcast) continue;
      member.row.broadcast = broadcast;
      this.remember(this.store.setBroadcast(member.row.id, broadcast));
    }
    this.emit("roster");
  }

  /** Every entry `bench new` opened from `id`, at any depth - the set that
   * moves with it when broadcast changes. */
  private descendants(id: string): Entry[] {
    const found: Entry[] = [];
    const frontier = [id];
    while (frontier.length > 0) {
      const parent = frontier.shift()!;
      for (const candidate of this.entries.values()) {
        if (candidate.row.createdBy !== parent) continue;
        found.push(candidate);
        frontier.push(candidate.row.id);
      }
    }
    return found;
  }

  /**
   * Drop a specialist's conversation, and nothing else.
   *
   * The worktree, the branch, the reports and the spend all stay; what goes
   * is the memory the CLI was carrying. The next prompt starts a fresh
   * conversation, which is the one thing that fixes a specialist whose
   * context has filled to the point of dropping the start of itself, or
   * whose long history has it going in circles.
   *
   * The thread keeps its record, marked with a line saying what happened: a
   * visible history with a specialist that suddenly remembers none of it is
   * a history that lies, and the line is what makes it tell the truth. What
   * was actually said before the clear is written as a report - the same
   * report.html/decision.json shape a specialist writes for itself - so it
   * survives a restart and shows up on the roster instead of living only in
   * memory until the next prompt happens to consume it.
   */
  clearContext(id: string): boolean {
    const entry = this.entries.get(id);
    if (!entry) return false;

    entry.resumable = false;
    entry.row.context = null;
    entry.clearCount = (entry.clearCount ?? 0) + 1;

    // The report this clear writes claims the next turn slot, the same way a
    // real turn would - read while the live session still knows its own
    // count, because that reference is about to be stopped. A cold
    // specialist has no live count to read, so entry.turnsTaken (accurate
    // for one that has never run this daemon's uptime) stands in for it.
    const reportSeq = (entry.session?.turn ?? entry.turnsTaken) + 1;
    entry.turnsTaken = reportSeq;

    const reportReady = writeClearContextReport(entry.reportsDir, entry.threadPath, reportSeq, entry.clearCount)
      .then(async ({ summary }) => {
        entry.threadSummary = summary || null;
        entry.row.latestReportSeq = reportSeq;
        await appendEntry(entry.threadPath, {
          kind: "report",
          body: "Context cleared",
          reportSeq,
        });
        this.emit("roster");
        return summary;
      })
      .catch((err: unknown) => {
        process.stderr.write(`bench: could not write the clear-context report: ${String(err)}\n`);
        return "";
      });

    this.remember(this.store.forgetConversation(id, entry.clearCount));
    void appendEntry(entry.threadPath, {
      kind: "system",
      body: `Context cleared — the next prompt starts a fresh conversation (version ${entry.clearCount}).`,
    });

    // A live process is still holding the old conversation. Let it go; the
    // next prompt brings it back empty. The same shape as setModel/setRole:
    // marked before the kill so the exit reads as a decision, not a crash.
    // Watched here, separately from attach()'s own exit handler, because
    // reviving needs the process gone and the report written before it can
    // safely send anything.
    const exited = entry.session
      ? new Promise<void>((resolve) => entry.session!.once("exit", () => resolve()))
      : Promise.resolve();

    if (entry.session) {
      entry.stopping = true;
      entry.stoppedBecause = "context cleared";
      entry.session.stop();
    } else {
      this.emit("roster");
    }

    // The fresh session picks itself back up once there is something to pick
    // up: an empty conversation has nothing to continue, so it waits for the
    // developer instead of spending a turn on nothing.
    void Promise.all([reportReady, exited]).then(([summary]) => {
      const revived = this.entries.get(id);
      if (!revived || summary === "") return;
      this.deliver(id, revived, "[bench] Context was cleared. Continue from where you left off.");
    });

    return true;
  }

  stop(id: string): void {
    const entry = this.entries.get(id);
    if (!entry?.session) return;
    entry.stopping = true;
    entry.session.stop();
  }

  /**
   * Close a specialist for good. The store is what boot reads, so deleting
   * the record is what makes it stay gone.
   *
   * The worktree goes too - it is the expensive part, and leaving one behind
   * per closed specialist is how a machine fills up. What is inside it is
   * not cheap, though, so anything uncommitted or unmerged stops the close
   * and says what would be lost. The thread and reports are kept: they are
   * small, and they are the record of what the specialist actually did.
   */
  async close(id: string, opts: { force?: boolean } = {}): Promise<{
    closed: boolean;
    changes: number;
    unmergedCommits: number;
  }> {
    const entry = this.entries.get(id);
    if (!entry) return { closed: false, changes: 0, unmergedCommits: 0 };

    const branch = entry.branch;
    // Closing a specialist that works in the checkout itself removes nothing,
    // so there is no work for it to destroy and nothing to warn about. The
    // developer's uncommitted changes stay exactly where they are.
    const state = entry.worktree === "" || !entry.isolated
      ? { clean: true, changes: 0, unmergedCommits: 0 }
      : await inspectWorktree(entry.row.project, entry.worktree, branch);

    if (!state.clean && !opts.force) {
      return { closed: false, changes: state.changes, unmergedCommits: state.unmergedCommits };
    }

    entry.session?.stop();
    // Only ever remove what Bench created. Pointed at a project checkout this
    // would be `git worktree remove --force` and `branch -D` against the
    // developer's own tree; git refuses both today, but not by our design.
    if (entry.isolated && entry.worktree !== "") {
      await removeWorktree(entry.row.project, entry.worktree, branch).catch(() => {});
    }
    await this.store.remove(id);
    this.entries.delete(id);
    this.emit("roster");

    return { closed: true, changes: state.changes, unmergedCommits: state.unmergedCommits };
  }
}
