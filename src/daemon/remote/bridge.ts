import type { FirestoreClient } from "./firestore-rest.js";
import { readPresence, presencePath, VIEWER_STALE_MS } from "./presence.js";
import { commandsPath, resultPath, runPendingCommands, type LocalCaller } from "./command-runner.js";
import { MirrorWriter, mirrorSessionPath, mirrorRosterPath } from "./mirror-writer.js";
import { WriteBudget } from "./write-budget.js";
import type { RosterRow } from "../../shared/types.js";

/** How long with no fresh viewer before the poll backs off from "watched" to
 * "idle" cadence. Idling is slowing down, not stopping - a broadcast
 * specialist that went unreachable over lunch would defeat the point of
 * broadcasting it, so this only ever widens the interval, never opens it. */
const IDLE_AFTER_MS = 5 * 60_000;

/**
 * The daemon's half of "the wire": presence, commands, and the mirror, all
 * gated on the same question - is anyone actually watching this machine.
 *
 * No push listener. `firestore-rest.ts`'s own comment explains why: a real
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
 * which is what the budget actually binds on. Flagged in this ticket's
 * report for the developer to weigh.
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
}

export class RemoteBridge {
  private readonly opts: Required<Omit<RemoteBridgeOptions, "budget">> & { budget: WriteBudget };
  private readonly mirror: MirrorWriter;
  private supervisorTimer: ReturnType<typeof setInterval> | null = null;
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private active = false;
  private watching = new Set<string>();
  private lastPollAt = 0;
  private lastActiveAt: number;

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
  }

  /**
   * The one place every poll decision is made. Checked in this order:
   * nothing broadcast (free, local - answers most ticks without touching
   * Firestore at all), then whether this cadence's interval has actually
   * elapsed (also free), and only then a real read.
   */
  private async supervise(): Promise<void> {
    if (this.opts.listBroadcast().length === 0) {
      if (this.active) {
        this.active = false;
        this.stopTicking();
        await this.mirror.deleteAll();
      }
      return;
    }

    const now = this.opts.now();
    const watched = now - this.lastActiveAt < this.opts.idleAfterMs;
    const cadence = watched ? this.opts.viewerPollMs : this.opts.idlePollMs;
    if (now - this.lastPollAt < cadence) return;
    this.lastPollAt = now;

    const presence = await readPresence(this.opts.client, this.opts.uid, this.opts.machineId, now, this.opts.viewerStaleMs);
    this.watching = presence.watching;
    if (presence.active) this.lastActiveAt = now;

    if (presence.active && !this.active) {
      this.active = true;
      this.startTicking();
      // A viewer that just announced itself should not wait a full tick
      // interval for its first mirror - the poll that noticed it also
      // serves it.
      await this.tick();
    } else if (!presence.active && this.active) {
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

  private async tick(): Promise<void> {
    if (!this.active) return;
    const broadcastRows = this.opts.listBroadcast();

    const commandWrites = await runPendingCommands(
      this.opts.client, this.opts.uid, this.opts.machineId, broadcastRows, this.opts.callLocal,
    );
    this.opts.budget.record(commandWrites);

    await this.mirror.sync(broadcastRows, this.watching, this.opts.callLocal);
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
      const docs = await this.opts.client.list(path);
      for (const { id } of docs) await this.opts.client.remove(`${path}/${id}`);
    }
  }
}

export { mirrorRosterPath, mirrorSessionPath, resultPath };
