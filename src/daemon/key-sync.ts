import { keyHint, type KeyCheck, type ManagedKey } from "./anthropic-key.js";
import { checkManaged, RECHECK_AFTER } from "./managed-keys.js";
import type { FirestoreClient } from "./remote/firestore-rest.js";
import type { SessionRegistryLike } from "./server.js";
import type { Usage } from "./usage.js";

/** The same failure, reported every tick, is a log full of one line. Ten
 * minutes between repeats is enough to find it without drowning in it. */
const LOG_QUIET_MS = 10 * 60_000;

/** The credential document the profile writes - the daemon's half of the
 * same shape. `createdAt` is not a `ManagedKey` field; it is kept here only
 * so a write-back does not erase it. */
interface CredentialDoc {
  id: string;
  key: string;
  label: string;
  hint: string;
  status: string;
  checkedAt: number;
  createdAt: number;
  resetsAt: string | null;
}

const stringOf = (value: unknown): string => (typeof value === "string" ? value : "");
const numberOf = (value: unknown): number => (typeof value === "number" ? value : 0);

function docOf(id: string, data: Record<string, unknown>): CredentialDoc | null {
  const key = stringOf(data.key).trim();
  if (key === "") return null;
  return {
    id,
    key,
    label: stringOf(data.label) || "Anthropic key",
    hint: stringOf(data.hint) || keyHint(key),
    status: stringOf(data.status) || "unchecked",
    checkedAt: numberOf(data.checkedAt),
    createdAt: numberOf(data.createdAt),
    resetsAt: stringOf(data.resetsAt) || null,
  };
}

/**
 * The daemon's own copy of the profile's Anthropic keys, so they work with
 * no cockpit open.
 *
 * The profile dialog is still where keys are typed and where a save lands
 * instantly - this is the loop that keeps the daemon's list matching
 * Firestore while it runs: new keys get checked, keys the daemon already
 * knows are left alone until their check is stale, and verdicts the daemon
 * reaches on its own (a window filling, a reset passing) are written back
 * so every other Bench and the next boot see them.
 */
export class KeySync {
  private client: FirestoreClient | null = null;
  private uid: string | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private inFlight: Promise<void> | null = null;
  private seenKeys = new Map<string, string>();
  private lastLogged = new Map<string, number>();

  private readonly intervalMs: number;
  private readonly now: () => number;
  private readonly log: (line: string) => void;
  private readonly setIntervalImpl: typeof setInterval;
  private readonly clearIntervalImpl: typeof clearInterval;

  constructor(private deps: {
    registry: Pick<SessionRegistryLike, "setManagedApiKeys" | "managedApiKeyStates" | "refreshManagedUsage">;
    check: (key: string) => Promise<KeyCheck>;
    usageOf: (key: string) => Promise<Usage>;
    intervalMs?: number;
    now?: () => number;
    setIntervalImpl?: typeof setInterval;
    clearIntervalImpl?: typeof clearInterval;
    log?: (line: string) => void;
  }) {
    this.intervalMs = deps.intervalMs ?? 60_000;
    this.now = deps.now ?? Date.now;
    this.log = deps.log ?? ((line) => process.stderr.write(`${line}\n`));
    this.setIntervalImpl = deps.setIntervalImpl ?? setInterval;
    this.clearIntervalImpl = deps.clearIntervalImpl ?? clearInterval;
  }

  /** Point the loop at an identity. Called again, it replaces the previous
   * target - a re-sign-in, or remote connecting as a different account. */
  start(client: FirestoreClient, uid: string): void {
    this.stop();
    this.client = client;
    this.uid = uid;
    void this.tick();
    this.timer = this.setIntervalImpl(() => { void this.tick(); }, this.intervalMs);
    (this.timer as unknown as { unref?: () => void }).unref?.();
  }

  stop(): void {
    if (this.timer !== null) this.clearIntervalImpl(this.timer);
    this.timer = null;
    this.client = null;
    this.uid = null;
  }

  /** One pass over the collection. Overlapping calls - the interval landing
   * while a tick is still waiting on Firestore - share the in-flight one. */
  tick(): Promise<void> {
    this.inFlight ??= this.run()
      .catch((error) => this.report(error))
      .finally(() => { this.inFlight = null; });
    return this.inFlight;
  }

  private async run(): Promise<void> {
    const client = this.client;
    const uid = this.uid;
    if (client === null || uid === null) return;

    const collection = `users/${uid}/anthropicCredentials`;
    const docs = (await client.list(collection))
      .map((doc) => docOf(doc.id, doc.data))
      .filter((doc): doc is CredentialDoc => doc !== null);
    this.seenKeys = new Map(docs.map((doc) => [doc.id, doc.key]));

    // The daemon's states are fresher than the documents while it is
    // running - a rotation or a usage refresh has already moved them on.
    // What Firestore still owns is the label.
    const held = new Map(this.deps.registry.managedApiKeyStates().map((state) => [state.id, state]));
    const now = this.now();

    const recheck = new Set<string>();
    const toCheck: CredentialDoc[] = [];
    for (const doc of docs) {
      const state = held.get(doc.id);
      const due = state === undefined
        || now - state.checkedAt >= RECHECK_AFTER
        || (state.status === "exhausted" && state.resetsAt != null && Date.parse(state.resetsAt) <= now);
      if (!due) continue;
      recheck.add(doc.id);
      // A known key goes back in carrying the daemon's verdict, so
      // checkManaged's cooldown rule applies to the fresher of the two.
      toCheck.push(state === undefined ? doc : {
        ...doc,
        status: state.status,
        checkedAt: state.checkedAt,
        resetsAt: state.resetsAt ?? null,
      });
    }
    const checked = new Map(
      (await checkManaged(toCheck, {
        check: this.deps.check,
        usageOf: this.deps.usageOf,
        fallbackLabel: "Anthropic key",
        now: this.now,
      })).map((item) => [item.id, item]),
    );

    const all: ManagedKey[] = [];
    for (const doc of docs) {
      const fresh = checked.get(doc.id);
      if (fresh) { all.push(fresh); continue; }
      const state = held.get(doc.id)!;
      all.push({
        id: doc.id, key: doc.key, label: doc.label,
        status: state.status, checkedAt: state.checkedAt,
        usage: state.usage, resetsAt: state.resetsAt,
      });
    }
    this.deps.registry.setManagedApiKeys(all);

    // Windows move on their own clock; ask before deciding what to write back.
    await this.deps.registry.refreshManagedUsage(this.deps.usageOf);

    const states = new Map(this.deps.registry.managedApiKeyStates().map((state) => [state.id, state]));
    for (const doc of docs) {
      const state = states.get(doc.id);
      if (!state) continue;
      if (
        state.status === doc.status
        && state.checkedAt === doc.checkedAt
        && (state.resetsAt ?? null) === doc.resetsAt
      ) continue;
      await client.set(`${collection}/${doc.id}`, {
        key: this.seenKeys.get(doc.id) ?? doc.key,
        label: doc.label,
        hint: doc.hint,
        status: state.status,
        checkedAt: state.checkedAt,
        createdAt: doc.createdAt,
        ...(state.resetsAt ? { resetsAt: state.resetsAt } : {}),
      });
    }
  }

  private report(error: unknown): void {
    const line = `bench: key sync: ${String(error instanceof Error ? error.message : error)}`;
    const last = this.lastLogged.get(line) ?? 0;
    if (this.now() - last < LOG_QUIET_MS) return;
    this.lastLogged.set(line, this.now());
    this.log(line);
  }
}
