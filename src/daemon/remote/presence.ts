import type { FirestoreClient } from "./firestore-rest.js";

/**
 * `/users/{uid}/machines/{machineId}/presence/state` - one document, holding
 * every device watching this machine's cockpit as a `viewers` map. Not a
 * collection: a collection listing bills one read per document, where a
 * single document bills one read flat however many devices there are. See
 * "Presence becomes one document" in the design.
 *
 * The trailing `/state` is one segment more than the design's own path -
 * a Firestore path alternates collection/document/collection/document, so
 * `.../machines/{machineId}/presence` names a *collection* called
 * `presence`, the same shape as `.../machines/{machineId}/mirror` does for
 * `mirror/roster`. A fixed document id under it is what makes it the one
 * document the design means.
 */
export interface ViewerEntry {
  at: number;
  /** Empty string stands in for "watching nothing" - a map value has no
   * null, see `remote-codec.ts` for the same trade made generally. */
  watching: string;
}

/** A viewer is stale after three minutes with no heartbeat - see the design.
 * Firestore has no `onDisconnect`; this window is what stands in for one. */
export const VIEWER_STALE_MS = 3 * 60_000;

export function presencePath(uid: string, machineId: string): string {
  return `users/${uid}/machines/${machineId}/presence/state`;
}

/** What presence resolves to: whether to mirror at all, and if so, which
 * sessions some fresh viewer actually has open. */
export interface Presence {
  active: boolean;
  watching: Set<string>;
}

function isViewerEntry(value: unknown): value is ViewerEntry {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.at === "number" && typeof v.watching === "string";
}

/** Reads the one presence document and decides what the daemon owes its
 * viewers - one read, however many devices are in the map. A fresh viewer's
 * `watching` (when not "watching nothing") joins the set of sessions worth a
 * detail mirror; the roster mirror only needs one fresh viewer to exist at
 * all. */
export async function readPresence(
  client: FirestoreClient,
  uid: string,
  machineId: string,
  now: number,
  staleMs = VIEWER_STALE_MS,
): Promise<Presence> {
  const doc = await client.get(presencePath(uid, machineId));
  const viewers = doc?.viewers;
  const watching = new Set<string>();
  let active = false;

  if (typeof viewers === "object" && viewers !== null) {
    for (const entry of Object.values(viewers)) {
      if (!isViewerEntry(entry)) continue;
      if (now - entry.at >= staleMs) continue;
      active = true;
      if (entry.watching !== "") watching.add(entry.watching);
    }
  }

  return { active, watching };
}
