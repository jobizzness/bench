import type { FirestoreClient } from "./firestore-rest.js";

/** `/users/{uid}/machines/{machineId}/viewers/{deviceId}` - one document per
 * device watching this machine's cockpit. See "Presence gates the mirror" in
 * the design. */
export interface ViewerDoc {
  at: number;
  /** Empty string stands in for "watching nothing" - `DocData` has no null,
   * see `remote-codec.ts` for the same trade made generally. */
  watching: string;
}

/** A viewer is stale after three minutes with no heartbeat - see the design. */
export const VIEWER_STALE_MS = 3 * 60_000;

export function viewersPath(uid: string, machineId: string): string {
  return `users/${uid}/machines/${machineId}/viewers`;
}

/** What presence resolves to: whether to mirror at all, and if so, which
 * sessions some fresh viewer actually has open. */
export interface Presence {
  active: boolean;
  watching: Set<string>;
}

/** Reads every viewer document and decides what the daemon owes them. A
 * fresh viewer's `watching` (when not "watching nothing") joins the set of
 * sessions worth a detail mirror; the roster mirror only needs one fresh
 * viewer to exist at all. */
export async function readPresence(
  client: FirestoreClient,
  uid: string,
  machineId: string,
  now: number,
  staleMs = VIEWER_STALE_MS,
): Promise<Presence> {
  const docs = await client.list(viewersPath(uid, machineId));
  const watching = new Set<string>();
  let active = false;
  for (const { data } of docs) {
    const at = typeof data.at === "number" ? data.at : 0;
    if (now - at >= staleMs) continue;
    active = true;
    const session = typeof data.watching === "string" ? data.watching : "";
    if (session !== "") watching.add(session);
  }
  return { active, watching };
}
