import { EventEmitter } from "node:events";
import { mkdir, access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { loadConfig } from "./config.js";
import { createServer, type SessionRegistryLike } from "./server.js";
import {
  changedFiles, createWorktree, currentBranch, excludeBenchDir, fileAtCommit, inspectWorktree,
  removeWorktree, type SessionChanges,
} from "./worktree.js";
import { bootstrapWorktree, BootstrapError } from "./bootstrap.js";
import { ClaudeSession } from "./claude-session.js";
import { DevinSession } from "./devin-session.js";
import { runtimeFor, type Session } from "./session.js";
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
import { isOauthToken, isUsageLimitError, limitResetsAt, type ManagedKey } from "./anthropic-key.js";
import { fullestPercent, type Usage, type UsageWindow } from "../shared/usage.js";
import { catalogue, isOpenRouterModel, settledCostOfTurn, type Listed } from "./gemini.js";
import { devinFamilyOf, isModelId, modelLabel } from "../shared/models.js";
import type { AttachmentRef, EditEvent, RosterRow, SessionStatus, Spend, StoredAttachment } from "../shared/types.js";
import { costOfTurn, type Price, type TurnShape } from "../shared/cost.js";
import { costFrom, shapeFrom } from "./stream-codec.js";
import type { FileTouch, ResultEvent } from "./stream-codec.js";
import { TurnLog } from "./turns.js";
import { Ledger, type Total } from "./ledger.js";
import { nudgeFor, type NudgeState } from "../shared/nudge.js";
import { attachmentPath } from "./attachments.js";

/**
 * The bytes behind a held brief's images, read back off disk.
 *
 * Only refs are recorded with the brief, so this is where they become
 * something the CLI can be handed again. An image that has gone missing is
 * dropped rather than failing the restore: losing one picture from a brief
 * is recoverable, losing the whole roster because of it is not.
 */
async function rereadAttachments(reportsDir: string, refs: AttachmentRef[]): Promise<StoredAttachment[]> {
  const read = await Promise.all(refs.map(async (ref) => {
    const path = attachmentPath(reportsDir, ref.name);
    if (path === null) return null;
    try {
      return { ...ref, data: (await readFile(path)).toString("base64") };
    } catch {
      return null;
    }
  }));
  return read.filter((image): image is StoredAttachment => image !== null);
}

interface Entry {
  row: RosterRow;
  reportsDir: string;
  threadPath: string;
  session: Session | null;
  alive: boolean;
  /** Enough to bring the specialist back after the daemon has restarted. */
  worktree: string;
  branch: string;
  /** False when the specialist works in the project checkout itself. */
  isolated: boolean;
  /** Whether the CLI has a conversation to resume. See SessionRecord. */
  resumable: boolean;
  /** The runtime's own session id, for runtimes that assign their own. Used
   * by DevinSession to call `session/load` on revive rather than `session/new`
   * with a fresh id. Undefined for Claude sessions. */
  runtimeSessionId?: string;
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
  /**
   * The Anthropic credential changed while this specialist was mid-turn.
   *
   * The process cannot be moved onto the new one - env is fixed at spawn -
   * but killing it under a running turn loses the turn. So the change is
   * noted here and acted on at turn-end, which is the first moment letting
   * the process go costs nothing.
   */
  credentialStale?: boolean;
  model: string;
  port: number;
  /** The specialist whose `bench new` opened this tab, if one did. Persisted:
   * the roster nests a child under its opener, and the nesting has to survive
   * a restart. It does double duty before the first turn, where it is also how
   * the daemon knows to hold a sender's message for dispatch - and the held
   * brief is on disk too now (`pendingDispatch`), so both halves of that job
   * survive a restart together. */
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
  /** What an agent told this tab, waiting on the developer to dispatch it.
   * Mirrored to the store: it waits on a person rather than a process, so a
   * restart has nothing to invalidate - and dropping it left the tab reading
   * "ready", as if the brief had never been sent (#66). */
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
   * The Anthropic key specialists are spawned with: the active managed key
   * from the developer's profile. In memory and nowhere else - it is synced
   * down from the profile on every save and is gone when the daemon is.
   */
  private apiKey: string | null = null;
  private managedApiKeys: ManagedKey[] = [];
  private activeManagedKeyId: string | null = null;
  private retryPrompts = new Map<string, { text: string; images: StoredAttachment[] }>();
  private credentialRetries = new Set<string>();
  /** The key each specialist's current process was spawned with - so what
   * its stream reports about a key lands on that key, even after the bench
   * has moved the rest of the roster onto another. */
  private spawnedWith = new Map<string, string | undefined>();

  /**
   * The developer's OpenRouter key, for specialists run on anybody other than
   * Anthropic. In memory and nowhere else, the same rule the Anthropic key
   * follows: an override kept in a file is one you forget you set.
   */
  private routerKey: string | null = null;
  private managedRouterKeys: ManagedKey[] = [];
  private activeManagedRouterKeyId: string | null = null;

  /** The catalogue, once fetched. OpenRouter serves several hundred models
   * and the list changes rarely, so it is read once and kept rather than
   * fetched every time the picker opens. */
  private models: Listed[] | null = null;

  constructor(private readonly config: ReturnType<typeof loadConfig>) {
    super();
    this.store = new SessionStore(config.home);
    this.turns = new TurnLog(config.home);
    this.ledger = new Ledger(config.home);
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
      throw new Error("no OpenRouter key - add one in your profile to run a specialist on this model");
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

  /** The key to authenticate with. Null when there is no managed key, in
   * which case a spawned specialist inherits whatever the daemon has - the
   * machine's own login. */
  getApiKey(): string | null {
    return this.apiKey;
  }

  /**
   * The credential to spawn a specialist with.
   *
   * `undefined`, not `null`, when there is no key of our own: `null` would
   * clear the child's credential variables outright, which is not "I have no
   * key to offer" but "be certain you have none" - and that spawns a process
   * that cannot authenticate and says only that it failed. Falling back to
   * the daemon's own login is what an absent key has always meant, and it is
   * the difference between a bench that keeps working on the machine's
   * account and one that stops dead with nothing to read.
   */
  private credentialForSpawn(): string | undefined {
    return this.apiKey ?? undefined;
  }

  /**
   * Load the developer's managed keys, and pick the one to spend.
   *
   * A key is passed over only when it is known not to work. "Could not be
   * checked" is not that: the check is one HTTPS request against a provider
   * that rate-limits, made for every key at once, every time the profile
   * dialog syncs - so an inconclusive verdict is the common case on a slow
   * network, not evidence about the key. Treating it as failure would drop
   * every specialist on the bench and leave nothing to revive them with,
   * which is a far worse answer than trying a key that may well be fine.
   */
  setManagedApiKeys(keys: ManagedKey[]): void {
    // A re-check that could not say what a key has spent is not news that it
    // has spent nothing - for a setup-token it never can. Keep what the last
    // turn on that same key reported.
    const before = new Map(this.managedApiKeys.map((item) => [item.id, item]));
    this.managedApiKeys = keys.map((item) => {
      const prior = before.get(item.id);
      return item.usage === undefined && prior?.usage !== undefined && prior.key === item.key
        ? { ...item, usage: prior.usage }
        : item;
    });
    const next = this.pickManagedKey();
    this.activeManagedKeyId = next?.id ?? null;
    this.applyApiKey(next?.key ?? null);
  }

  /**
   * Which managed key to spend, given what is known about each.
   *
   * The key already in use while it is still usable - churn between two
   * half-full windows is worth nothing. Otherwise the available key with the
   * most headroom left, then any key whose check was inconclusive, in the
   * order the profile lists them.
   */
  private pickManagedKey(exclude?: string): ManagedKey | undefined {
    const usable = (item: ManagedKey) =>
      item.id !== exclude && item.status !== "exhausted" && item.status !== "refused";
    if (exclude === undefined) {
      const current = this.managedApiKeys.find((item) => item.id === this.activeManagedKeyId && usable(item));
      if (current) return current;
    }
    const available = this.managedApiKeys.filter((item) => usable(item) && item.status === "available");
    if (available.length > 0) {
      return available.reduce((best, item) =>
        fullestPercent(item.usage ?? []) < fullestPercent(best.usage ?? []) ? item : best);
    }
    return this.managedApiKeys.find(usable);
  }

  managedApiKeyStates(): Array<Omit<ManagedKey, "key"> & { active: boolean }> {
    return this.managedApiKeys.map(({ key: _key, ...item }) => ({ ...item, active: item.id === this.activeManagedKeyId }));
  }

  /**
   * The OpenRouter half of the same list. Same selection rule as the
   * Anthropic keys, without the rotation: a proxied turn bills the account
   * the key belongs to, so a dead one is reported rather than worked around.
   */
  setManagedRouterKeys(keys: ManagedKey[]): void {
    this.managedRouterKeys = keys;
    const usable = (item: ManagedKey) => item.status !== "exhausted" && item.status !== "refused";
    const current = keys.find((item) => item.id === this.activeManagedRouterKeyId && usable(item));
    const next = current ?? keys.find((item) => item.status === "available") ?? keys.find(usable);
    this.activeManagedRouterKeyId = next?.id ?? null;
    this.routerKey = next?.key ?? null;
  }

  managedRouterKeyStates(): Array<Omit<ManagedKey, "key"> & { active: boolean }> {
    return this.managedRouterKeys.map(({ key: _key, ...item }) => ({ ...item, active: item.id === this.activeManagedRouterKeyId }));
  }

  /** `said` is the CLI's own account of the failure - for a setup-token, the
   * only place its reset time is ever given. */
  private rotateManagedApiKey(said = ""): boolean {
    const active = this.managedApiKeys.find((item) => item.id === this.activeManagedKeyId);
    if (active) {
      active.status = "exhausted";
      active.checkedAt = Date.now();
      const full = (active.usage ?? []).filter((window) => window.percent >= 100);
      if (full.length > 0) {
        active.resetsAt = full.map((window) => window.resetsAt).filter((at): at is string => at !== null).sort()[0] ?? null;
      } else {
        const told = limitResetsAt(said, active.checkedAt);
        if (told !== null) active.resetsAt = told;
      }
    }
    const next = this.pickManagedKey(this.activeManagedKeyId ?? undefined);
    this.activeManagedKeyId = next?.id ?? null;
    this.applyApiKey(next?.key ?? null);
    return next !== undefined;
  }

  /**
   * What a specialist's own stream says the key it was spawned with has
   * spent.
   *
   * A refusal marks the key spent until the time it names. Moving off it is
   * left to the turn that was refused, which rotates and retries in one step
   * - moving here as well would rotate twice, the second time off the key
   * just moved onto.
   */
  private recordKeyUsage(key: string | undefined, limits: { status: string; resetsAt: string | null; windows: UsageWindow[] }): void {
    const item = this.managedApiKeys.find((candidate) => candidate.key === key);
    if (!item) return;
    if (limits.windows.length > 0) item.usage = limits.windows;
    if (limits.status === "rejected") {
      item.status = "exhausted";
      item.resetsAt = limits.resetsAt ?? item.resetsAt ?? null;
    }
  }

  /**
   * Re-ask each managed OAuth key what it has spent, and move off one whose
   * window has filled.
   *
   * Called from the route the profile polls, so a key that runs out at 3pm
   * is noticed without a turn having to fail first. A key whose window has
   * turned over again comes back as available. One refresh at a time: two
   * polls landing together are one set of requests, not two.
   */
  private refreshingUsage: Promise<void> | null = null;

  refreshManagedUsage(fetchUsage: (key: string) => Promise<Usage>): Promise<void> {
    this.refreshingUsage ??= this.doRefreshManagedUsage(fetchUsage)
      .finally(() => { this.refreshingUsage = null; });
    return this.refreshingUsage;
  }

  private async doRefreshManagedUsage(fetchUsage: (key: string) => Promise<Usage>): Promise<void> {
    for (const item of this.managedApiKeys) {
      if (!isOauthToken(item.key) || Date.now() - item.checkedAt < 60_000) continue;
      const usage = await fetchUsage(item.key);
      if (!usage.available) continue;
      item.usage = usage.windows;
      item.checkedAt = Date.now();
      const full = usage.windows.filter((window) => window.percent >= 100);
      if (full.length > 0) {
        item.status = "exhausted";
        item.resetsAt = full.map((window) => window.resetsAt).filter((at): at is string => at !== null).sort()[0] ?? null;
      } else if (
        item.status === "exhausted"
        && item.resetsAt != null
        && Date.parse(item.resetsAt) <= Date.now()
      ) {
        item.status = "available";
        item.resetsAt = null;
      }
    }

    const usable = (item: ManagedKey) => item.status !== "exhausted" && item.status !== "refused";
    const current = this.managedApiKeys.find((item) => item.id === this.activeManagedKeyId && usable(item));
    if (!current) {
      const next = this.pickManagedKey();
      this.activeManagedKeyId = next?.id ?? null;
      this.applyApiKey(next?.key ?? null);
    }
  }

  /**
   * Point specialists at a new key, letting go of the ones still running on
   * the old one - but only when the key actually moved, or re-syncing the
   * same list would drop every process on the bench.
   */
  private applyApiKey(key: string | null): void {
    if (this.apiKey === key) return;
    this.apiKey = key;
    this.credentialChanged();
  }

  /**
   * A specialist already running is still spending the credential it was
   * spawned with. Let it go.
   *
   * The same shape as setModel, and for the same reason: the credential
   * reaches the process in its environment, and an environment is fixed at
   * spawn. So the change is recorded and the process is let go - the next
   * prompt revives it on the new credential, resuming the same transcript.
   * Without this, "change the key to another account" is a setting that takes
   * effect on tabs opened afterwards and on no others, which is not what
   * anyone means by it.
   *
   * Lazy rather than eager, as everywhere else here: reviving now would spend
   * a turn's startup on every tab at once, for a key the developer may still
   * be adjusting.
   */
  private credentialChanged(): void {
    for (const entry of this.entries.values()) {
      if (!entry.session) continue;

      // Mid-turn. Killing it here loses the turn and the developer did
      // nothing to that tab; it is dropped at turn-end instead.
      if (entry.session.turnStartedAt !== null) {
        entry.credentialStale = true;
        continue;
      }

      this.letGoForCredential(entry);
    }
    this.emit("roster");
  }

  /** Drop the process, saying why. `stoppedBecause` rather than a bare stop,
   * which would put "stopped by you" on a row for something the developer did
   * not do to that tab. */
  private letGoForCredential(entry: Entry): void {
    entry.credentialStale = false;
    if (!entry.session) return;
    entry.stopping = true;
    entry.stoppedBecause = "the Anthropic key changed";
    entry.session.stop();
  }

  /** The OpenRouter key to authenticate with. Read by the credit meter's
   * source, which the server is deliberately unable to reach past. */
  getRouterKey(): string | null {
    return this.routerKey;
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

  async restore(): Promise<void> {
    this.settings = await readSettings(this.config.home);

    for (const rec of await this.store.all()) {
      const worktreeGone = !existsSync(rec.worktree);
      // Read once and used twice: what has already been answered, and whether
      // this specialist has ever spoken.
      const thread = await readThread(join(rec.reportsDir, "thread.jsonl"));
      const held = rec.pendingDispatch ?? null;
      const heldImages = held === null ? [] : await rereadAttachments(rec.reportsDir, rec.pendingImages ?? []);
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
        runtimeSessionId: rec.runtimeSessionId,
        model: rec.model,
        port: rec.port,
        createdBy: rec.createdBy ?? null,
        dispatched: thread.length > 0,
        // A brief waits on a person, not on a process, so unlike everything
        // else that was in flight it loses nothing by a restart - and being
        // dropped left the tab reading "ready", indistinguishable from one
        // never given work (#66). Images are refs on disk; the bytes are
        // re-read below, and an image that has gone is dropped from the
        // brief rather than failing the whole restore.
        pendingDispatch: held,
        pendingImages: heldImages,
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
          status: worktreeGone ? "crashed" : held !== null ? "awaiting_dispatch" : "awaiting_decision",
          detail: worktreeGone
            ? "worktree is gone"
            : held !== null ? "waiting on you to dispatch" : "ready",
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
          pendingPrompt: held,
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

  /**
   * What a specialist has changed since its branch started, for the editor's
   * sidebar (#128).
   *
   * A specialist working in the checkout itself has no worktree of its own,
   * so it is asked about the project directory - where its uncommitted work
   * genuinely is.
   */
  async changes(id: string): Promise<SessionChanges | null> {
    const entry = this.entries.get(id);
    if (!entry) return null;
    const root = this.treeOf(entry);
    // The root travels with the files because the paths are relative to it,
    // and nothing outside the daemon should be reconstructing a worktree
    // path from a label and an id.
    return { ...await changedFiles(entry.row.project, root, entry.branch), root };
  }

  /**
   * One of those files as it was before the specialist touched it. The other
   * side of the diff is the file on disk, which an editor can open itself.
   */
  async baseBlob(id: string, path: string): Promise<string | null> {
    const entry = this.entries.get(id);
    if (!entry) return null;
    const { base } = await changedFiles(entry.row.project, this.treeOf(entry), entry.branch);
    if (base === null) return null;
    return fileAtCommit(this.treeOf(entry), base, path);
  }

  private treeOf(entry: Entry): string {
    return entry.worktree === "" ? entry.row.project : entry.worktree;
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
    /** The ACP session id to resume, for runtimes that assign their own.
     * Passed to DevinSession as `resumeSessionId`; ignored by ClaudeSession. */
    resumeSessionId?: string;
    clearCount?: number;
    startTurn?: number;
    /** Set for an OpenRouter model, already resolved. */
    via?: { key: string; contextLength?: number | null };
  }): Session {
    const entry = this.entries.get(id)!;
    const reportsDir = entry.reportsDir;

    const session = runtimeFor(opts.model) === "devin"
      ? new DevinSession({
          id,
          worktree: opts.worktree,
          reportsDir,
          role: opts.role,
          port: opts.port,
          cockpitUrl: `http://127.0.0.1:${this.config.port}`,
          devinBin: this.config.devinBin,
          model: devinFamilyOf(opts.model),
          startTurn: opts.startTurn,
          resumeSessionId: opts.resumeSessionId,
          rules: () => houseRules(this.settings),
          nudge: () => this.nudgeTextFor(id),
          onSessionId: (sid) => this.store.rememberRuntimeSessionId(id, sid),
        })
      : new ClaudeSession({
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
          // Through the getter, not off the field: the key is read at spawn,
          // and undefined there means "inherit the daemon's own login".
          apiKey: () => {
            const key = this.credentialForSpawn();
            this.spawnedWith.set(id, key);
            return key;
          },
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

    // Not held on the row: an edit is a moment, not state. Anything that
    // wants it is listening now, and a page that reloads has missed it -
    // which is right, because the file it would have opened is already open.
    session.on("edit", (touch: FileTouch) => {
      const current = this.entries.get(id);
      if (!current) return;
      this.emit("edit", {
        id,
        label: current.row.label,
        project: current.row.project,
        tool: touch.tool,
        path: touch.path,
        ...(touch.wrote === undefined ? {} : { wrote: touch.wrote }),
        at: new Date().toISOString(),
      } satisfies EditEvent);
    });

    session.on("rate-limit", (limits: { status: string; resetsAt: string | null; windows: UsageWindow[] }) => {
      this.recordKeyUsage(this.spawnedWith.get(id), limits);
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

      // The opposite lie: `resumable` said there was a conversation to
      // continue and the runtime says there never was one it knows about.
      // Most often this is a record left over from a model change that
      // crossed a runtime boundary before it was cleared at the boundary
      // (#113) - Claude's own refusal here is proof there is nothing to
      // resume, so believe that instead of repeating the same crash forever.
      // Heal the claim, and if a prompt was waiting on this attempt, start it
      // fresh rather than making the developer notice and resend it.
      if (entry && opts.resume && /no conversation found with session id/i.test(stderr ?? "")) {
        entry.resumable = false;
        entry.runtimeSessionId = undefined;
        this.remember(this.store.clearStaleResume(id));
        // Only retried here for a plain Claude model: an OpenRouter one needs
        // `via` re-resolved first, which is what `deliver()` already does on
        // the developer's next prompt - and that prompt now revives with
        // `resume: false`, since the claim above is healed.
        const retry = this.retryPrompts.get(id);
        if (retry && !isOpenRouterModel(entry.model)) {
          this.revive(id, entry, undefined);
          entry.session!.send(retry.text, retry.images);
          this.update(id, "working", "starting a new conversation");
          return;
        }
      }

      // Asked for, not suffered. The specialist is still here and its next
      // prompt revives it from the last turn it finished.
      if (entry?.stopping) {
        entry.stopping = false;
        if (this.credentialRetries.delete(id)) {
          const retry = this.retryPrompts.get(id);
          entry.stoppedBecause = undefined;
          if (retry) {
            this.revive(id, entry, undefined);
            entry.session!.send(retry.text, retry.images);
            this.update(id, "working", "retrying with another credential");
            return;
          }
        }
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

      const retry = this.retryPrompts.get(id);
      if (entry && retry && runtimeFor(entry.model) === "claude" && !isOpenRouterModel(entry.model) && isUsageLimitError(stderr) && this.rotateManagedApiKey(stderr ?? "")) {
        this.revive(id, entry, undefined);
        entry.session!.send(retry.text, retry.images);
        this.update(id, "working", "retrying with another credential");
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
      const told = `${result.subtype} ${result.result ?? ""}`;
      const limited = result.is_error && isUsageLimitError(told);
      if (runtimeFor(entry.model) === "claude" && !isOpenRouterModel(entry.model) && limited && this.retryPrompts.has(id) && this.rotateManagedApiKey(told)) {
        this.credentialRetries.add(id);
        return;
      }
      this.retryPrompts.delete(id);

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

      // The key changed under this turn. Now that the turn is over, letting
      // the process go costs nothing, and the next prompt brings it back on
      // the credential the developer actually chose.
      //
      // Unless a queued prompt has already become the running turn - the
      // session starts one the moment the last ends - in which case this is
      // the same "mid-turn" it was before and waits for the next turn-end.
      if (entry.credentialStale && session.turnStartedAt === null) {
        this.letGoForCredential(entry);
      }
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
    /** The caller's own say on whether this should be mirrored. Present only
     * from a remote cockpit (#76) - when it is, it wins outright; when it is
     * absent, the existing rule below (inherit from createdBy, else false)
     * is unchanged, so a local cockpit and an older client are unaffected. */
    broadcast?: boolean;
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

    // A tab opened by a specialist that is broadcast is broadcast itself.
    //
    // `setBroadcast` already carries the flag to every descendant, on exactly
    // the reasoning that "a specialist and the researcher it spun up are one
    // piece of work" - but it only reaches the ones that exist when the
    // switch is flipped, and the interesting ones are opened afterwards.
    // Without this, a specialist supervised from a phone can open a sub-agent
    // and hand it a prompt, and the tab is never mirrored, never appears on
    // the phone's roster, and answers 403 to the dispatch it is waiting for
    // (#75).
    //
    // Read from the parent's row rather than inherited blindly: a tab opened
    // by a specialist that is not broadcast stays unbroadcast, and one the
    // developer opened from the cockpit has no parent to inherit from, so
    // both keep the off-by-default this has always had.
    //
    // A caller that states its own opinion wins outright (#76) - a remote
    // cockpit's own New button, the only path where the request could only
    // have reached the daemon through the developer's own authenticated
    // session in the first place.
    const broadcast = input.broadcast !== undefined
      ? input.broadcast
      : input.createdBy === undefined
        ? false
        : this.entries.get(input.createdBy)?.row.broadcast ?? false;

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
        // Off by default, and inherited from the parent when there is one.
        // See `setBroadcast` for what turning it on means, and the note
        // above for why creation honours it too.
        broadcast,
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
        // Written here rather than through `store.setBroadcast` afterwards:
        // `put` replaces the whole record, so a flag set before this call
        // would be wiped by it. Absent when false, which is what "never
        // broadcast" has always looked like on disk (see `SessionRecord`).
        ...(broadcast ? { broadcast: true } : {}),
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
  private revive(id: string, entry: Entry, via: { key: string; contextLength?: number | null } | undefined): Session {
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
      // For runtimes that assign their own session id (Devin), pass it so
      // `session/load` uses the exact same id the runtime knows about.
      resumeSessionId: entry.resumable ? entry.runtimeSessionId : undefined,
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
      this.rememberDispatch(id, text, images);
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
    this.rememberDispatch(id, null);
    this.deliver(id, entry, text, images);
  }

  /**
   * Mirror a held brief to disk, or clear it once it has been answered.
   *
   * Fire-and-forget because every caller is synchronous, so the rejection has
   * nowhere to go but the process - which is precisely how an unhandled
   * rejection took the whole daemon down once already (#59). A brief that
   * fails to reach disk is still held in memory for this daemon's lifetime;
   * saying so is better than dying over it.
   */
  private rememberDispatch(id: string, text: string | null, images: StoredAttachment[] = []): void {
    void this.store
      .rememberDispatch(id, text, images.map(({ name, mediaType }) => ({ name, mediaType })))
      .catch((error) => {
        process.stderr.write(`bench: could not record the held brief for ${id}: ${String(error)}\n`);
      });
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
    this.rememberDispatch(id, null);
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
    this.retryPrompts.set(id, { text: promptText, images });

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
   * takes every time the daemon restarts. That only holds within a runtime:
   * crossing between `devin` and any Claude model leaves no transcript for
   * the new one to resume, so the conversation is dropped instead (#113).
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

    // A conversation belongs to the runtime that holds it. Crossing to a
    // different one (devin <-> any Claude model) leaves nothing for the new
    // runtime to resume, and asking it to anyway is what crashes the tab
    // (#113) - so the in-memory claim is cleared right alongside the model,
    // not just the on-disk one `store.remodel` clears below.
    if (runtimeFor(entry.model) !== runtimeFor(model)) {
      entry.resumable = false;
      entry.runtimeSessionId = undefined;
    }

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
