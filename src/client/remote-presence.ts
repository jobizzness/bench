import { deleteField, doc, setDoc, updateDoc, type Firestore } from "firebase/firestore";
import { randomId } from "./uuid.js";

/** Every 60s while the page is visible - see "Presence gates the mirror" in
 * the design. Not while hidden: a phone in a pocket is not a viewer, and an
 * idle tab must not spend the day's write budget proving it is open. */
export const HEARTBEAT_MS = 60_000;

/** See `presence.ts`'s comment on `presencePath` for why this ends in
 * `/state` rather than `/presence` - a Firestore path alternates
 * collection/document, so a fixed document id is what makes this the one
 * document per machine rather than a collection called "presence". */
function presenceRef(db: Firestore, uid: string, machineId: string) {
  return doc(db, `users/${uid}/machines/${machineId}/presence/state`);
}

/**
 * One heartbeat, for one machine - a merge into that machine's single
 * `presence` document rather than a document of its own, so the daemon's
 * poll costs one read regardless of how many devices are watching. See
 * "Presence becomes one document" in the design.
 *
 * Written with a dotted field path (`viewers.{deviceId}`) rather than a
 * plain nested object: several devices heartbeat this same document
 * concurrently, and a dotted-path update only ever touches its own leaf,
 * where a read-modify-write of the whole map would drop another device's
 * heartbeat that landed in between.
 */
export async function heartbeat(
  db: Firestore, uid: string, machineId: string, deviceId: string, watching: string | null,
): Promise<void> {
  const ref = presenceRef(db, uid, machineId);
  const entry = { at: Date.now(), watching: watching ?? "" };
  try {
    await updateDoc(ref, `viewers.${deviceId}`, entry);
  } catch {
    // No presence document yet - this machine has never had a viewer.
    // `updateDoc` requires the document to exist; `setDoc` creates it.
    await setDoc(ref, { viewers: { [deviceId]: entry } });
  }
}

/** Called on the way out - closing the tab, or broadcast going off locally -
 * so a viewer that leaves cleanly does not wait three minutes to go stale.
 * Removes only this device's entry from the map, the same dotted-path
 * reasoning as `heartbeat`. */
export async function stopWatching(db: Firestore, uid: string, machineId: string, deviceId: string): Promise<void> {
  try {
    await updateDoc(presenceRef(db, uid, machineId), `viewers.${deviceId}`, deleteField());
  } catch {
    // No document, or no entry for this device - either way, already gone.
  }
}

const KEY = "bench:device-id";

/** One id per browser, kept in `localStorage` - stable across reloads, so a
 * phone's viewer entry is the same map key on every visit rather than a new
 * one the daemon has to notice separately each time. */
export function deviceId(store: Storage = localStorage): string {
  try {
    const existing = store.getItem(KEY);
    if (existing) return existing;
    const fresh = randomId();
    store.setItem(KEY, fresh);
    return fresh;
  } catch {
    // Storage disabled: a fresh id every call is a viewer that never quite
    // looks continuous, but it still heartbeats and still watches.
    return randomId();
  }
}
