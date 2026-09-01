import type { FirestoreClient } from "./firestore-rest.js";
import type { WriteBudget } from "./write-budget.js";
import type { LocalCaller } from "./command-runner.js";
import { encode } from "../../shared/remote-codec.js";
import type { RosterRow } from "../../shared/types.js";

export function mirrorRosterPath(uid: string, machineId: string): string {
  return `users/${uid}/machines/${machineId}/mirror/roster`;
}

export function mirrorSessionPath(uid: string, machineId: string, sessionId: string): string {
  return `users/${uid}/machines/${machineId}/mirror/${sessionId}`;
}

const BASE_COALESCE_MS = 2_000;

/**
 * What the daemon pushes for a presence-gated viewer to read: the roster
 * mirror while any viewer is fresh, and one detail mirror per session some
 * viewer actually has open. See "Things you watch" in the design.
 *
 * Holds the coalescing state itself - the last payload and when it was last
 * written, per document - so `bridge.ts` can call `sync()` on every tick
 * without knowing anything about debouncing. Deletes are never coalesced:
 * a session that stops being watched, or stops being broadcast, loses its
 * mirror on the same tick that notices, not two seconds later.
 */
export class MirrorWriter {
  private lastRoster: string | null = null;
  private lastRosterWriteAt = 0;
  private sessionPayloads = new Map<string, string>();
  private sessionWriteAt = new Map<string, number>();

  constructor(
    private readonly client: FirestoreClient,
    private readonly uid: string,
    private readonly machineId: string,
    private readonly budget: WriteBudget,
    private readonly now: () => number,
  ) {}

  /** Every session currently holding a mirror document, so the bridge can
   * clean them all up when the last viewer goes stale. */
  mirroredSessions(): string[] {
    return [...this.sessionPayloads.keys()];
  }

  /** Returns the number of Firestore *writes* made this tick (deletes are
   * not budget-limited by the design and are not counted here). */
  async sync(broadcastRows: RosterRow[], watching: Set<string>, callLocal: LocalCaller): Promise<number> {
    let writes = 0;
    writes += await this.syncRoster(broadcastRows);

    const broadcastIds = new Set(broadcastRows.map((r) => r.id));
    const shouldMirror = [...watching].filter((id) => broadcastIds.has(id));
    await this.deleteUnwanted(new Set(shouldMirror));
    for (const id of shouldMirror) writes += await this.syncSession(id, callLocal);
    return writes;
  }

  /** Everything this machine currently mirrors, gone - the viewer that made
   * it worth writing has gone stale. */
  async deleteAll(): Promise<void> {
    await this.client.remove(mirrorRosterPath(this.uid, this.machineId));
    for (const id of this.mirroredSessions()) {
      await this.client.remove(mirrorSessionPath(this.uid, this.machineId, id));
    }
    this.lastRoster = null;
    this.sessionPayloads.clear();
    this.sessionWriteAt.clear();
  }

  private async syncRoster(rows: RosterRow[]): Promise<number> {
    const payload = encode(rows);
    if (payload === this.lastRoster) return 0;

    const cadence = this.budget.cadence(BASE_COALESCE_MS);
    if (!cadence.timedWritesAllowed) return 0;
    if (this.now() - this.lastRosterWriteAt < cadence.coalesceMs) return 0;

    await this.client.set(mirrorRosterPath(this.uid, this.machineId), {
      payload,
      degraded: this.budget.degraded() ? 1 : 0,
    });
    this.lastRoster = payload;
    this.lastRosterWriteAt = this.now();
    this.budget.record();
    return 1;
  }

  private async syncSession(id: string, callLocal: LocalCaller): Promise<number> {
    const detail = await this.readDetail(id, callLocal);
    const payload = encode(detail);
    if (payload === this.sessionPayloads.get(id)) return 0;

    const cadence = this.budget.cadence(BASE_COALESCE_MS);
    if (!cadence.timedWritesAllowed) return 0;
    const lastWrite = this.sessionWriteAt.get(id) ?? 0;
    if (this.now() - lastWrite < cadence.coalesceMs) return 0;

    await this.client.set(mirrorSessionPath(this.uid, this.machineId, id), { payload });
    this.sessionPayloads.set(id, payload);
    this.sessionWriteAt.set(id, this.now());
    this.budget.record();
    return 1;
  }

  /** Thread and plan, read the same way a phone's own commands would reach
   * them - one implementation of each route. A session's `activity` and
   * `latestReportSeq` are already on the roster row, so the roster mirror
   * carries those; this only adds what a row cannot. */
  private async readDetail(id: string, callLocal: LocalCaller): Promise<{ thread: unknown; plan: unknown }> {
    const [thread, plan] = await Promise.all([
      callLocal("GET", `/api/sessions/${id}/thread`, undefined),
      callLocal("GET", `/api/sessions/${id}/plan`, undefined),
    ]);
    return {
      thread: thread.status === 200 ? JSON.parse(thread.text) : null,
      plan: plan.status === 200 ? JSON.parse(plan.text) : null,
    };
  }

  private async deleteUnwanted(shouldMirror: Set<string>): Promise<void> {
    for (const id of this.mirroredSessions()) {
      if (shouldMirror.has(id)) continue;
      await this.client.remove(mirrorSessionPath(this.uid, this.machineId, id));
      this.sessionPayloads.delete(id);
      this.sessionWriteAt.delete(id);
    }
  }
}
