import type { FirestoreClient } from "./firestore-rest.js";
import { readPresence, viewersPath, VIEWER_STALE_MS } from "./presence.js";
import { commandsPath, resultPath, runPendingCommands, type LocalCaller } from "./command-runner.js";
import { MirrorWriter, mirrorSessionPath, mirrorRosterPath } from "./mirror-writer.js";
import { WriteBudget } from "./write-budget.js";
import type { RosterRow } from "../../shared/types.js";

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
 * instead - `viewers` on a slow, always-on cadence (cheap: one collection,
 * usually one or two documents), `commands` and the mirror only while a
 * viewer is fresh, on a faster cadence. It costs reads the design assumed
 * would be free; it does not cost writes, which is what the budget actually
 * binds on. Flagged in this ticket's report for the developer to weigh.
 */
export interface RemoteBridgeOptions {
  client: FirestoreClient;
  uid: string;
  machineId: string;
  /** Read fresh every tick - never cached, so a broadcast flip is reflected
   * on the next tick without this module knowing the registry exists. */
  listBroadcast: () => RosterRow[];
  callLocal: LocalCaller;
  now?: () => number;
  setIntervalImpl?: typeof setInterval;
  clearIntervalImpl?: typeof clearInterval;
  /** How often `viewers` is polled. Always running while remote is on -
   * see the class comment for why this one has to be cheap. */
  viewerPollMs?: number;
  /** How often `commands` and the mirror are serviced, while active. */
  tickMs?: number;
  viewerStaleMs?: number;
  budget?: WriteBudget;
}

export class RemoteBridge {
  private readonly opts: Required<Omit<RemoteBridgeOptions, "budget">> & { budget: WriteBudget };
  private readonly mirror: MirrorWriter;
  private viewerTimer: ReturnType<typeof setInterval> | null = null;
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private active = false;
  private watching = new Set<string>();

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
      tickMs: opts.tickMs ?? 2_000,
      viewerStaleMs: opts.viewerStaleMs ?? VIEWER_STALE_MS,
      budget: opts.budget ?? new WriteBudget({ now }),
    };
    this.mirror = new MirrorWriter(opts.client, opts.uid, opts.machineId, this.opts.budget, now);
  }

  /** Idle listeners are free; polling is not, so this is the one timer that
   * runs for the life of "remote is on" regardless of whether anyone is
   * watching - see the class comment. The first check waits one interval
   * rather than firing immediately, which keeps `pollViewers()` the single
   * path into activation instead of racing a synchronous one against it. */
  start(): void {
    if (this.viewerTimer) return;
    this.viewerTimer = this.opts.setIntervalImpl(() => { void this.pollViewers(); }, this.opts.viewerPollMs);
    this.viewerTimer.unref?.();
  }

  stop(): void {
    if (this.viewerTimer) this.opts.clearIntervalImpl(this.viewerTimer);
    this.viewerTimer = null;
    this.stopTicking();
  }

  private async pollViewers(): Promise<void> {
    const presence = await readPresence(
      this.opts.client, this.opts.uid, this.opts.machineId, this.opts.now(), this.opts.viewerStaleMs,
    );
    this.watching = presence.watching;

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
    for (const path of [
      commandsPath(this.opts.uid, this.opts.machineId),
      `users/${this.opts.uid}/machines/${this.opts.machineId}/results`,
      viewersPath(this.opts.uid, this.opts.machineId),
      `users/${this.opts.uid}/machines/${this.opts.machineId}/mirror`,
    ]) {
      const docs = await this.opts.client.list(path);
      for (const { id } of docs) await this.opts.client.remove(`${path}/${id}`);
    }
  }
}

export { mirrorRosterPath, mirrorSessionPath, resultPath };
