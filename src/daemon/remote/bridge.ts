import type { FirestoreClient } from "./firestore-rest.js";
import { evaluatePresence, readPresence, presencePath, VIEWER_STALE_MS, type Presence } from "./presence.js";
import type { ListenerTargetSpec, RemoteListener } from "./firestore-listen.js";
import { commandsPath, resultPath, runPendingCommands, type LocalCaller } from "./command-runner.js";
import { MirrorWriter, mirrorSessionPath, mirrorRosterPath } from "./mirror-writer.js";
import { WriteBudget } from "./write-budget.js";
import type { RosterRow } from "../../shared/types.js";

/** How long with no fresh viewer before the poll backs off from "watched" to
 * "idle" cadence. Idling is slowing down, not stopping - a broadcast
 * specialist that went unreachable over lunch would defeat the point of
 * broadcasting it, so this only ever widens the interval, never opens it. */
const IDLE_AFTER_MS = 5 * 60_000;

/** How long to stop calling Firestore after it says the daily quota is
 * spent - long enough that a paused day costs a few dozen refused probes
 * rather than thousands, short enough to resume soon after the reset. */
const QUOTA_PAUSE_MS = 15 * 60_000;

/**
 * How long the mirror outlives its last viewer. A reload is the page leaving
 * and the same page coming straight back: tearing the mirror down on the
 * leave meant the page that came back found no roster, showed "waking", and
 * waited for the whole mirror to be written again. Long enough for a reload
 * or a quick tab-away; short enough that an abandoned mirror is not kept up
 * for long.
 */
const MIRROR_GRACE_MS = 2 * 60_000;

/**
 * An error worth reading. `undici` reports every network failure as the same
 * `TypeError: fetch failed` and puts the thing you actually need - a connect
 * timeout, a reset, a DNS failure - in `cause`, so logging the error alone
 * says only that something went wrong and never what.
 */
function describe(error: unknown): string {
  const cause = error instanceof Error ? (error as { cause?: unknown }).cause : undefined;
  return cause === undefined ? String(error) : `${String(error)} (${String(cause)})`;
}

/**
 * The daemon's half of "the wire": presence, commands, and the mirror, all
 * gated on the same question - is anyone actually watching this machine.
 *
 * Push first, polling as the fallback. When `listen` is supplied (the daemon
 * always supplies it, see `firestore-listen.ts`), one Firestore `Listen`
 * stream carries presence and commands: a command runs the moment it lands,
 * a viewer is noticed the moment it heartbeats, and nothing is billed to
 * confirm that nothing changed. Everything below describes what happens
 * while that stream is not healthy - before it first connects, or on a
 * network that will not carry it - and is what this file did on its own
 * before the listener existed.
 *
 * The polling fallback, and why it was ever the only path: a real
 * `onSnapshot` needs the Firestore client SDK authenticated, and that SDK has
 * no supported way to establish a session from a bare refresh token without
 * either the Admin SDK (ruled out - see the design's identity section) or
 * reaching into the Auth SDK's private, unversioned persisted-session format.
 * Neither is something to build production behaviour on, so this polls
 * instead, on three cadences:
 *
 * - Nothing broadcast: no polling at all. Broadcast is strict, so an empty
 *   broadcast set is an empty mirror - there is nothing a viewer could see,
 *   so there is no question worth asking Firestore.
 * - Broadcast, watched (a fresh viewer seen within the last five minutes):
 *   every `viewerPollMs` (5s by default).
 * - Broadcast, unwatched for five minutes: every `idlePollMs` (60s).
 *
 * It costs reads the design assumed would be free; it does not cost writes,
 * which is what the budget actually binds on. Measured since: a watched
 * machine spends 60,456 reads a day, 71% of it the `commands` listing on the
 * tick below, which bills a read per tick to confirm an empty collection is
 * still empty. See "What it costs" in the design for the full table.
 *
 * What made that bite was not the cadence but who was making the machine
 * watched: a signed-in cockpit on the machine's own desk used to heartbeat
 * its own daemon, so a laptop with nobody looking at it from anywhere paid
 * the watched rate all day. That is fixed on the client (`useLocalMachineId`),
 * which is the right place for it - this side cannot tell one viewer from
 * another, and should not try. The read path stays unbudgeted: with only
 * genuine viewers waking it, the idle cadence is what a machine costs when
 * nobody is watching, and that is 1,440 reads a day.
 */
export interface RemoteBridgeOptions {
  client: FirestoreClient;
  uid: string;
  machineId: string;
  /** Read fresh every supervisor tick - never cached, so a broadcast flip is
   * reflected on the next tick without this module knowing the registry
   * exists. */
  listBroadcast: () => RosterRow[];
  callLocal: LocalCaller;
  now?: () => number;
  setIntervalImpl?: typeof setInterval;
  clearIntervalImpl?: typeof clearInterval;
  /** The cadence while watched, and the granularity the supervisor itself
   * runs at - fine enough to hit this exactly, and cheap to run when it is
   * only checking local state and not polling. */
  viewerPollMs?: number;
  /** The cadence once unwatched for `IDLE_AFTER_MS`. */
  idlePollMs?: number;
  /** How often `commands` and the mirror are serviced, while active. */
  tickMs?: number;
  viewerStaleMs?: number;
  idleAfterMs?: number;
  budget?: WriteBudget;
  /** Opens a push listener on the given targets. Absent means poll only -
   * what every test that predates the listener gets by not passing it. */
  listen?: (targets: ListenerTargetSpec[], onChange: (key: string) => void) => RemoteListener;
  /** Where an unreachable-Firestore notice goes. Injected so a test can read
   * what was said rather than watch the process's own stderr. */
  warn?: (message: string) => void;
}

export class RemoteBridge {
  private readonly opts: Required<Omit<RemoteBridgeOptions, "budget" | "listen">> & {
    budget: WriteBudget;
    listen: RemoteBridgeOptions["listen"];
  };
  private listener: RemoteListener | null = null;
  /** Set when a push arrives mid-supervise, so it is acted on as soon as
   * the current pass ends rather than at the next timer tick. */
  private superviseAgain = false;
  /** Commands this bridge has already answered - see `command-runner.ts`. */
  private readonly doneCommands = new Map<string, number>();
  private readonly mirror: MirrorWriter;
  private supervisorTimer: ReturnType<typeof setInterval> | null = null;
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private active = false;
  private supervising = false;
  private ticking = false;
  private tickAgain = false;
  private watching = new Set<string>();
  private lastPollAt = 0;
  private lastActiveAt: number;
  /** Which of the two pollers is currently failing, so each is reported once
   * when it starts failing and once when it recovers. Per-poller rather than
   * one flag for both: they run at different cadences and fail for different
   * reasons, and a single flag made one consistently broken poller read as a
   * flapping network - 189 "could not reach" lines alternating perfectly with
   * 189 "reached again" lines, which is a log that actively misleads. */
  private readonly unreachable = new Set<string>();
  /** Set when Firestore answers 429 - the project's daily free quota is
   * spent. Every further call would be refused the same way until it resets
   * (around midnight Pacific), so retrying on the usual cadence only adds
   * refused calls; this waits, then probes once. */
  private quotaPausedUntil = 0;

  constructor(opts: RemoteBridgeOptions) {
    const now = opts.now ?? Date.now;
    this.opts = {
      client: opts.client,
      uid: opts.uid,
      machineId: opts.machineId,
      listBroadcast: opts.listBroadcast,
      callLocal: opts.callLocal,
      now,
      setIntervalImpl: opts.setIntervalImpl ?? setInterval,
      clearIntervalImpl: opts.clearIntervalImpl ?? clearInterval,
      viewerPollMs: opts.viewerPollMs ?? 5_000,
      idlePollMs: opts.idlePollMs ?? 60_000,
      tickMs: opts.tickMs ?? 2_000,
      viewerStaleMs: opts.viewerStaleMs ?? VIEWER_STALE_MS,
      idleAfterMs: opts.idleAfterMs ?? IDLE_AFTER_MS,
      budget: opts.budget ?? new WriteBudget({ now }),
      listen: opts.listen,
      warn: opts.warn ?? ((message: string) => { process.stderr.write(message); }),
    };
    this.mirror = new MirrorWriter(opts.client, opts.uid, opts.machineId, this.opts.budget, now);
    // A broadcast that has just turned on gets the fast cadence for its
    // first five minutes even with nobody seen yet - someone broadcasting is
    // a strong signal they are about to go look, and "idle" is not the
    // guess to make about a specialist a second old.
    this.lastActiveAt = now();
  }

  /** Runs for the life of "remote is on", at the fastest cadence this bridge
   * ever polls at - but a local check of `listBroadcast()`, not a Firestore
   * call, so idling costs nothing even though the timer keeps firing. */
  start(): void {
    if (this.supervisorTimer) return;
    this.supervisorTimer = this.opts.setIntervalImpl(() => { void this.supervise(); }, this.opts.viewerPollMs);
    this.supervisorTimer.unref?.();
  }

  stop(): void {
    if (this.supervisorTimer) this.opts.clearIntervalImpl(this.supervisorTimer);
    this.supervisorTimer = null;
    this.stopTicking();
    this.stopListening();
  }

  private startListening(): void {
    if (this.listener || !this.opts.listen) return;
    const base = `users/${this.opts.uid}/machines/${this.opts.machineId}`;
    this.listener = this.opts.listen([
      { key: "presence", kind: "document", path: presencePath(this.opts.uid, this.opts.machineId) },
      { key: "commands", kind: "collection", path: `${base}/commands` },
    ], (key) => {
      if (key === "presence") void this.supervise();
      else if (key === "commands") void this.runPushedCommands();
    });
    this.listener.start();
  }

  private stopListening(): void {
    this.listener?.stop();
    this.listener = null;
  }

  /** The listener is up and consistent - its cache is what Firestore holds. */
  private listening(): boolean {
    return this.listener?.healthy() ?? false;
  }

  /**
   * A command pushed by the listener: run it now, whether or not a viewer has
   * been seen yet. A command is itself proof someone is looking, and gating
   * it on presence would only add a heartbeat's worth of latency to the very
   * first tap. Broadcast is still enforced inside `runPendingCommands`.
   */
  private async runPushedCommands(): Promise<void> {
    if (!this.listener || this.quotaPaused()) return;
    const broadcastRows = this.opts.listBroadcast();
    if (broadcastRows.length === 0) return;
    try {
      const writes = await runPendingCommands(
        this.opts.client, this.opts.uid, this.opts.machineId, broadcastRows, this.opts.callLocal,
        this.listener.docs("commands"), this.doneCommands,
      );
      this.opts.budget.record(writes);
      this.noteReachable("command run");
    } catch (error) {
      this.opts.budget.record(writesBeforeFailure(error));
      this.noteUnreachable("command run", error);
    }
  }

  /**
   * The one place every poll decision is made. Checked in this order:
   * nothing broadcast (free, local - answers most ticks without touching
   * Firestore at all), then whether this cadence's interval has actually
   * elapsed (also free), and only then a real read.
   *
   * Never rejects. Both timers here are fire-and-forget, so a rejection has
   * nowhere to go but the process - which is how ten seconds of no network
   * took the whole daemon down and every specialist with it (#59). The
   * cadence is already the retry: a failed poll costs one poll.
   */
  private async supervise(): Promise<void> {
    if (this.supervising) { this.superviseAgain = true; return; }
    this.supervising = true;
    try {
      do {
        this.superviseAgain = false;
        try {
          await this.superviseOnce();
          this.noteReachable("presence poll");
        } catch (error) {
          this.noteUnreachable("presence poll", error);
        }
      } while (this.superviseAgain);
    } finally {
      this.supervising = false;
    }
  }

  private async superviseOnce(): Promise<void> {
    if (this.opts.listBroadcast().length === 0) {
      // Nothing a viewer could see, so nothing worth a stream either.
      this.stopListening();
      if (this.active) {
        this.stopTicking();
        // Emptied before the flag flips, not after: if this throws, the
        // bridge has to still believe it is active or it will never come
        // back to finish, leaving a stale mirror in Firestore for a phone
        // to read as a live roster.
        await this.mirror.deleteAll();
        this.active = false;
      }
      return;
    }

    this.startListening();
    this.listener?.refreshAuth();

    const now = this.opts.now();
    let presence: Presence;
    if (this.listening()) {
      // Pushed, so free to re-evaluate on every pass - which is also what
      // notices a viewer going stale, since staleness is a matter of time
      // passing rather than of the document changing.
      const doc = this.listener!.docs("presence")[0]?.data ?? null;
      presence = evaluatePresence(doc, now, this.opts.viewerStaleMs);
    } else {
      if (this.quotaPaused()) return;
      const watched = now - this.lastActiveAt < this.opts.idleAfterMs;
      const cadence = watched ? this.opts.viewerPollMs : this.opts.idlePollMs;
      if (now - this.lastPollAt < cadence) return;
      this.lastPollAt = now;
      presence = await readPresence(this.opts.client, this.opts.uid, this.opts.machineId, now, this.opts.viewerStaleMs);
    }
    // While nobody is watching, keep mirroring what was last watched: the
    // grace below exists for the page that is about to come back to it.
    const newlyWatched = presence.active && [...presence.watching].some((id) => !this.watching.has(id));
    if (presence.active) {
      this.watching = presence.watching;
      this.lastActiveAt = now;
    }

    if (presence.active && !this.active) {
      this.active = true;
      this.startTicking();
      // A viewer that just announced itself should not wait a full tick
      // interval for its first mirror - the poll that noticed it also
      // serves it.
      await this.tick();
    } else if (presence.active && newlyWatched) {
      // A tab switch: write its mirror now rather than on the next tick.
      await this.tick();
    } else if (!presence.active && this.active && now - this.lastActiveAt >= MIRROR_GRACE_MS) {
      this.active = false;
      this.stopTicking();
      await this.mirror.deleteAll();
    }
  }

  private startTicking(): void {
    if (this.tickTimer) return;
    this.tickTimer = this.opts.setIntervalImpl(() => { void this.tick(); }, this.opts.tickMs);
    this.tickTimer.unref?.();
  }

  private stopTicking(): void {
    if (this.tickTimer) this.opts.clearIntervalImpl(this.tickTimer);
    this.tickTimer = null;
  }

  /** Never rejects, for the same reason `supervise` does not. */
  private async tick(): Promise<void> {
    // Asked for while one is running, it runs straight after - so a tab
    // switch that lands mid-tick is not left for the next interval.
    if (this.ticking) { this.tickAgain = true; return; }
    this.ticking = true;
    try {
      do {
        this.tickAgain = false;
        try {
          await this.tickOnce();
          this.noteReachable("mirror tick");
        } catch (error) {
          this.noteUnreachable("mirror tick", error);
        }
      } while (this.tickAgain);
    } finally {
      this.ticking = false;
    }
  }

  private async tickOnce(): Promise<void> {
    if (!this.active || this.quotaPaused()) return;
    const broadcastRows = this.opts.listBroadcast();

    if (this.listening()) {
      // Commands already run as they are pushed. This sweep costs no read
      // and catches one whose push landed while broadcast was briefly empty;
      // it is not awaited, so a slow command never holds the mirror back.
      void this.runPushedCommands();
    } else {
      // A failed command pass must not cost the viewer its mirror update as
      // well: the two are independent, so report it and carry on.
      try {
        const commandWrites = await runPendingCommands(
          this.opts.client, this.opts.uid, this.opts.machineId, broadcastRows, this.opts.callLocal,
          undefined, this.doneCommands,
        );
        this.opts.budget.record(commandWrites);
        this.noteReachable("command run");
      } catch (error) {
        this.opts.budget.record(writesBeforeFailure(error));
        this.noteUnreachable("command run", error);
      }
    }

    await this.mirror.sync(broadcastRows, this.watching, this.opts.callLocal);
  }

  /**
   * One line when a poller starts failing and one when it recovers, and
   * nothing in between. Polling continues either way, so an hour of failure
   * would otherwise be hundreds of identical lines - and a log nobody can
   * read is the same as no log, which is how remote would go quietly dead
   * without anyone noticing.
   */
  private noteUnreachable(what: string, error: unknown): void {
    if ((error as { status?: unknown } | null)?.status === 429) {
      const wasPaused = this.quotaPaused();
      this.quotaPausedUntil = this.opts.now() + QUOTA_PAUSE_MS;
      if (!wasPaused) {
        this.opts.warn(`bench: Firestore's daily quota is spent; remote pauses and checks again every ${QUOTA_PAUSE_MS / 60_000} minutes until it resets (around midnight Pacific)\n`);
      }
    }
    if (this.unreachable.has(what)) return;
    this.unreachable.add(what);
    this.opts.warn(`bench: remote ${what} failing, retrying on the next poll: ${describe(error)}\n`);
  }

  private quotaPaused(): boolean {
    return this.opts.now() < this.quotaPausedUntil;
  }

  private noteReachable(what: string): void {
    if (!this.unreachable.delete(what)) return;
    this.opts.warn(`bench: remote ${what} succeeded again\n`);
  }

  /**
   * `bench remote off` - empty this machine's whole subtree. Defensive
   * rather than load-bearing: presence already keeps these collections small
   * and short-lived, so in the common case there is nothing here to delete.
   * It matters on the path where remote goes off with a viewer mid-session,
   * or a command in flight.
   */
  async wipe(): Promise<void> {
    await this.opts.client.remove(presencePath(this.opts.uid, this.opts.machineId));
    for (const path of [
      commandsPath(this.opts.uid, this.opts.machineId),
      `users/${this.opts.uid}/machines/${this.opts.machineId}/results`,
      `users/${this.opts.uid}/machines/${this.opts.machineId}/mirror`,
    ]) {
      // In parallel: `bench remote off` waits on this, and one round trip per
      // leftover document, one after another, is what made it slow.
      const docs = await this.opts.client.list(path);
      await Promise.all(docs.map(({ id }) => this.opts.client.remove(`${path}/${id}`)));
    }
  }
}

/** Writes a failed `runPendingCommands` pass did make before it threw - see
 * that function's own comment. Zero for any other error. */
function writesBeforeFailure(error: unknown): number {
  const n = (error as { writesBeforeFailure?: unknown } | null)?.writesBeforeFailure;
  return typeof n === "number" ? n : 0;
}

export { mirrorRosterPath, mirrorSessionPath, resultPath };
