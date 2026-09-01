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

/** A machine's mirrored roster, and whether that machine says it is
 * spending its write budget faster than it would like - see "The write
 * budget" in the design and `write-budget.ts`. */
export interface MachineRoster {
  rows: RosterRow[];
  degraded: boolean;
}

/**
 * One machine's mirrored roster - broadcast specialists only, exactly as
 * that machine's own daemon chose to publish them. Null while there is
 * nothing mirrored (no viewer, or nothing broadcast), which is the normal
 * resting state and not an error.
 */
export function watchMachineRoster(
  db: Firestore, uid: string, machineId: string, onChange: (roster: MachineRoster | null) => void,
): Unsubscribe {
  return onSnapshot(doc(db, `users/${uid}/machines/${machineId}/mirror/roster`), (snapshot) => {
    if (!snapshot.exists()) { onChange(null); return; }
    const data = snapshot.data();
    onChange({
      rows: decode<RosterRow[]>(String(data.payload ?? "[]")),
      degraded: Number(data.degraded ?? 0) === 1,
    });
  });
}

export function machineIsAsleep(machine: RemoteMachine, now: number): boolean {
  return now - machine.lastSeen > MACHINE_ASLEEP_MS;
}

/** What a session's detail mirror carries - see `mirror-writer.ts`'s
 * `readDetail`. Everything else a session's row needs (`activity`,
 * `latestReportSeq`) is already on the roster row itself. */
export interface SessionMirror {
  thread: unknown;
  plan: unknown;
}

/**
 * `mirror/{sessionId}` - the one document a relayed session's live plan (and
 * thread) come from instead of a poll. Only ever populated while some viewer
 * has this session open (see "Presence gates the mirror" in the design), so
 * `null` is the ordinary state for a session nobody on any device is
 * currently looking at, not an error.
 */
export function watchSessionMirror(
  db: Firestore, uid: string, machineId: string, sessionId: string, onChange: (detail: SessionMirror | null) => void,
): Unsubscribe {
  return onSnapshot(doc(db, `users/${uid}/machines/${machineId}/mirror/${sessionId}`), (snapshot) => {
    if (!snapshot.exists()) { onChange(null); return; }
    onChange(decode<SessionMirror>(String(snapshot.data().payload ?? "null")));
  });
}
