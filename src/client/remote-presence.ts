import { deleteDoc, doc, setDoc, type Firestore } from "firebase/firestore";

/** Every 60s while the page is visible - see "Presence gates the mirror" in
 * the design. Not while hidden: a phone in a pocket is not a viewer, and an
 * idle tab must not spend the day's write budget proving it is open. */
export const HEARTBEAT_MS = 60_000;

function viewerRef(db: Firestore, uid: string, machineId: string, deviceId: string) {
  return doc(db, `users/${uid}/machines/${machineId}/viewers/${deviceId}`);
}

/** One heartbeat, for one machine. `watching` is the session this page has
 * open on that machine, or null - the daemon only mirrors detail for a
 * session some viewer is actually watching. */
export async function heartbeat(
  db: Firestore, uid: string, machineId: string, deviceId: string, watching: string | null,
): Promise<void> {
  await setDoc(viewerRef(db, uid, machineId, deviceId), { at: Date.now(), watching: watching ?? "" });
}

/** Called on the way out - closing the tab, or broadcast going off locally -
 * so a viewer that leaves cleanly does not wait three minutes to go stale. */
export async function stopWatching(db: Firestore, uid: string, machineId: string, deviceId: string): Promise<void> {
  await deleteDoc(viewerRef(db, uid, machineId, deviceId));
}

const KEY = "bench:device-id";

/** One id per browser, kept in `localStorage` - stable across reloads, so a
 * phone's viewer document is the same document on every visit rather than a
 * new one the daemon has to notice separately each time. */
export function deviceId(store: Storage = localStorage): string {
  try {
    const existing = store.getItem(KEY);
    if (existing) return existing;
    const fresh = crypto.randomUUID();
    store.setItem(KEY, fresh);
    return fresh;
  } catch {
    // Storage disabled: a fresh id every call is a viewer that never quite
    // looks continuous, but it still heartbeats and still watches.
    return crypto.randomUUID();
  }
}
