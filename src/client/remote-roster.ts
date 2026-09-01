import {
  collection, doc, onSnapshot, type Firestore, type Unsubscribe,
} from "firebase/firestore";
import { decode } from "../shared/remote-codec.js";
import type { RosterRow } from "../shared/types.js";

/** A daemon that has not touched `lastSeen` in this long is asleep - twice
 * the daemon's own heartbeat interval (`HEARTBEAT_MS` in `controller.ts`),
 * so one missed beat is not mistaken for gone. */
const MACHINE_ASLEEP_MS = 3 * 60_000;

export interface RemoteMachine {
  id: string;
  name: string;
  lastSeen: number;
}

/**
 * `/users/{uid}/machines` - every laptop signed into this account, whether
 * or not this page's own daemon is one of them. The merged roster in
 * `useRoster.ts` subscribes to every machine's `mirror/roster` in turn; this
 * is only the list of which machines exist.
 */
export function watchMachines(
  db: Firestore, uid: string, onChange: (machines: RemoteMachine[]) => void,
): Unsubscribe {
  return onSnapshot(collection(db, `users/${uid}/machines`), (snapshot) => {
    onChange(snapshot.docs.map((d) => ({
      id: d.id,
      name: String(d.data().name ?? d.id),
      lastSeen: Number(d.data().lastSeen ?? 0),
    })));
  });
}

/**
 * One machine's mirrored roster - broadcast specialists only, exactly as
 * that machine's own daemon chose to publish them. Null while there is
 * nothing mirrored (no viewer, or nothing broadcast), which is the normal
 * resting state and not an error.
 */
export function watchMachineRoster(
  db: Firestore, uid: string, machineId: string, onChange: (rows: RosterRow[] | null) => void,
): Unsubscribe {
  return onSnapshot(doc(db, `users/${uid}/machines/${machineId}/mirror/roster`), (snapshot) => {
    if (!snapshot.exists()) { onChange(null); return; }
    onChange(decode<RosterRow[]>(String(snapshot.data().payload ?? "[]")));
  });
}

export function machineIsAsleep(machine: RemoteMachine, now: number): boolean {
  return now - machine.lastSeen > MACHINE_ASLEEP_MS;
}
