import { useEffect, useMemo, useState } from "react";
import { getAuth } from "firebase/auth";
import type { Firestore } from "firebase/firestore";
import type { RosterRow } from "../../shared/types.js";
import { eventsUrl, linkIsStale, routeSession, setActiveMachine } from "../api.js";
import { shouldReconnect } from "../reconnect.js";
import { firebaseApp, firestore } from "../firebase-app.js";
import { watchMachines, watchMachineRoster, machineIsAsleep, type RemoteMachine } from "../remote-roster.js";
import { heartbeat, deviceId, HEARTBEAT_MS } from "../remote-presence.js";

export interface Roster {
  rows: RosterRow[];
  /** Whether the socket is up. `null` until the first one has settled either
   * way, so a page that is still connecting says nothing rather than
   * announcing a problem it does not have yet. */
  live: boolean | null;
}

/**
 * The roster, pushed over a socket the daemon owns. The daemon outlives the
 * page, so a dropped connection is reconnected - but a refused one is not,
 * because the token will not become valid by asking again.
 *
 * Whether the socket is up is part of what this hook knows, and it is not a
 * detail: installed on a phone, the cockpit is opened away from the daemon
 * all the time, and a roster of nobody looks exactly like having lost
 * everybody.
 *
 * Byte-for-byte what this hook was before #46 - same socket, same reconnect,
 * same `live` semantics. `useRemoteRoster` below is what gets merged in on
 * top, and it is a true no-op with nobody signed into Firebase in this
 * browser: no listener, no heartbeat, no Firestore call at all.
 */
function useLocalRoster(): Roster {
  const [rows, setRows] = useState<RosterRow[]>([]);
  const [live, setLive] = useState<boolean | null>(null);

  useEffect(() => {
    let disposed = false;
    let socket: WebSocket | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const connect = () => {
      const where = eventsUrl();
      // Nowhere to connect to: the page has not been told where its daemon
      // is, and the setup dialog is what is in front of the developer.
      if (where === null) return;
      socket = new WebSocket(where);

      socket.onopen = () => { if (!disposed) setLive(true); };

      socket.onmessage = (event) => {
        const message = JSON.parse(String(event.data));
        if (message.type === "roster") setRows(message.rows as RosterRow[]);
      };

      socket.onclose = (event) => {
        if (disposed) return;
        // A refused socket is a stale link, which has its own banner. Saying
        // "not connected" underneath it would be describing the same silence
        // twice, and only one of the two can be acted on.
        if (!shouldReconnect(event.code)) { linkIsStale(); return; }
        setLive(false);
        timer = setTimeout(connect, 1000);
      };
    };

    connect();
    return () => {
      disposed = true;
      clearTimeout(timer);
      socket?.close();
    };
  }, []);

  return { rows, live };
}

/**
 * Every other machine on the account, merged in - broadcast specialists
 * only, exactly as each machine's own daemon chose to mirror them. See "The
 * merged roster" in the design.
 *
 * Gated on this browser holding a signed-in Firebase user, checked once
 * rather than subscribed to: the sign-in itself happens on its own page (see
 * `useFirebaseUser.ts`), which reloads into a freshly signed-in cockpit
 * rather than flipping this hook's state live.
 */
function useRemoteRoster(watching: string | null): { rows: RosterRow[]; uid: string | null } {
  const uid = getAuth(firebaseApp()).currentUser?.uid ?? null;
  const db: Firestore | null = uid === null ? null : firestore();
  const [machines, setMachines] = useState<RemoteMachine[]>([]);
  const [byMachine, setByMachine] = useState<Map<string, RosterRow[]>>(new Map());

  useEffect(() => {
    if (db === null || uid === null) { setMachines([]); return; }
    return watchMachines(db, uid, setMachines);
  }, [db, uid]);

  useEffect(() => {
    if (db === null || uid === null || machines.length === 0) return;
    const unsubscribers = machines.map((machine) =>
      watchMachineRoster(db, uid, machine.id, (rows) => {
        setByMachine((prev) => {
          const next = new Map(prev);
          if (rows === null) next.delete(machine.id); else next.set(machine.id, rows);
          return next;
        });
      }));
    return () => { for (const unsubscribe of unsubscribers) unsubscribe(); };
  }, [db, uid, machines]);

  // Presence: one heartbeat per known machine, on a plain interval, only
  // while this tab is visible - see "Presence gates the mirror" in the
  // design. Announcing this page is the one thing it does unconditionally;
  // which session it is watching rides along, but only to the one machine
  // that session is actually on, so the right daemon mirrors its detail.
  useEffect(() => {
    if (db === null || uid === null || machines.length === 0) return;
    const id = deviceId();
    const beat = () => {
      if (document.visibilityState !== "visible") return;
      const owner = watching === null ? null : machineOwning(byMachine, watching);
      for (const machine of machines) {
        void heartbeat(db, uid, machine.id, id, machine.id === owner ? watching : null);
      }
    };
    beat();
    const timer = setInterval(beat, HEARTBEAT_MS);
    return () => clearInterval(timer);
  }, [db, uid, machines, watching, byMachine]);

  const rows = useMemo(() => {
    const now = Date.now();
    const flat: RosterRow[] = [];
    for (const [machineId, machineRows] of byMachine) {
      const machine = machines.find((m) => m.id === machineId);
      if (!machine || uid === null) continue;
      const asleep = machineIsAsleep(machine, now);
      for (const row of machineRows) {
        flat.push({ ...row, machine: { id: machine.id, name: machine.name, asleep } });
        routeSession(row.id, { uid, machineId });
      }
    }
    return flat;
  }, [byMachine, machines, uid]);

  return { rows, uid };
}

/** Which of the currently-mirrored machines a session actually belongs to,
 * so a heartbeat's `watching` field never names a session to a machine that
 * does not have it. */
function machineOwning(byMachine: Map<string, RosterRow[]>, sessionId: string): string | null {
  for (const [machineId, rows] of byMachine) {
    if (rows.some((r) => r.id === sessionId)) return machineId;
  }
  return null;
}

/**
 * `watching` is the session this page currently has open, so the right
 * machine mirrors its detail and heartbeats it correctly - see
 * `useRemoteRoster`. Every existing caller passes nothing, which is exactly
 * "not watching anything in particular" and changes nothing about the local
 * socket.
 */
export function useRoster(watching: string | null = null): Roster {
  const local = useLocalRoster();
  const remote = useRemoteRoster(watching);

  const rows = useMemo(() => {
    if (remote.rows.length === 0) return local.rows;
    const localIds = new Set(local.rows.map((r) => r.id));
    return [...local.rows, ...remote.rows.filter((r) => !localIds.has(r.id))];
  }, [local.rows, remote.rows]);

  // Machine-global routes - Settings, the keys, the project list - follow
  // whichever machine the open specialist is on, defaulting to local; see
  // "Machine-global routes" in the design. Kept in sync here rather than
  // asking every caller of a machine-global route to know which machine that
  // is - the same reasoning as `routeSession` above.
  useEffect(() => {
    const row = rows.find((r) => r.id === watching);
    setActiveMachine(row?.machine && remote.uid ? { uid: remote.uid, machineId: row.machine.id } : null);
  }, [rows, watching, remote.uid]);

  return { rows, live: local.live };
}
