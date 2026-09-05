import { useEffect, useMemo, useRef, useState } from "react";
import { getAuth } from "firebase/auth";
import type { Firestore } from "firebase/firestore";
import type { RosterRow } from "../../shared/types.js";
import { eventsUrl, linkIsStale, routeSession, setActiveMachine } from "../api.js";
import { shouldReconnect } from "../reconnect.js";
import { firebaseApp, firestore } from "../firebase-app.js";
import {
  watchMachines, watchMachineRoster, machineIsAsleep, type RemoteMachine, type MachineRoster,
} from "../remote-roster.js";
import { heartbeat, stopWatching, deviceId, HEARTBEAT_MS } from "../remote-presence.js";
import { useLocalMachineId } from "./useLocalMachineId.js";

export interface Roster {
  rows: RosterRow[];
  /** Whether the socket is up. `null` until the first one has settled either
   * way, so a page that is still connecting says nothing rather than
   * announcing a problem it does not have yet. */
  live: boolean | null;
  /** A remote machine whose daemon is running (`lastSeen` fresh) but has not
   * mirrored anything for this viewer yet - idling machines take up to a
   * minute to notice a new viewer and start mirroring again (see "Broadcast
   * gates the poll" in the design). Shown as waking rather than inventing an
   * empty roster for it; see `App.tsx`. Cannot always be told apart from a
   * machine with nothing broadcast on it at all - both look the same from
   * here - so this over-reports "waking" rather than under-reporting it. */
  wakingMachines: RemoteMachine[];
  /** A remote machine whose own daemon says it is spending its Firestore
   * write budget faster than it would like - see "The write budget" in the
   * design. The cockpit says so rather than quietly slowing down unnoticed. */
  degradedMachines: RemoteMachine[];
  /** Which machine the machine-global routes currently answer for, in a
   * word - `null` for the machine that served this page, a name for
   * anything else. See "Machine-global routes" in the design and
   * `SettingsDialog.tsx`, the one place this is shown. */
  activeMachineName: string | null;
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
function useLocalRoster(): Pick<Roster, "rows" | "live"> {
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
function useRemoteRoster(watching: string | null): {
  rows: RosterRow[]; uid: string | null; wakingMachines: RemoteMachine[]; degradedMachines: RemoteMachine[];
} {
  const uid = getAuth(firebaseApp()).currentUser?.uid ?? null;
  const db: Firestore | null = uid === null ? null : firestore();
  const [allMachines, setAllMachines] = useState<RemoteMachine[]>([]);
  const [byMachine, setByMachine] = useState<Map<string, MachineRoster>>(new Map());

  useEffect(() => {
    if (db === null || uid === null) { setAllMachines([]); return; }
    return watchMachines(db, uid, setAllMachines);
  }, [db, uid]);

  // Re-asked whenever the account's machines change, which is what catches
  // this machine registering itself after the cockpit already mounted - see
  // `useLocalMachineId`.
  const local = useLocalMachineId(allMachines.map((m) => m.id).sort().join(","));

  /**
   * Every machine on the account except the one that served this page.
   *
   * That machine is already answering over the local socket, so mirroring it
   * through Firestore buys nothing and costs a great deal: a heartbeat to
   * its own presence document is what tells its daemon a viewer has arrived,
   * and the daemon answers by running its full watched loop - a presence
   * poll every five seconds, a command list every two, and the mirror. A
   * signed-in cockpit left open on the developer's own desk therefore spent
   * 60,456 reads a day publishing a roster it already had. The rows looked
   * right the whole time, because the merge below dedupes by session id, so
   * nothing surfaced it.
   */
  const machines = useMemo(
    () => (local.id === null ? allMachines : allMachines.filter((m) => m.id !== local.id)),
    [allMachines, local.id],
  );

  useEffect(() => {
    if (db === null || uid === null || !local.settled || machines.length === 0) return;
    const unsubscribers = machines.map((machine) =>
      watchMachineRoster(db, uid, machine.id, (roster) => {
        setByMachine((prev) => {
          const next = new Map(prev);
          if (roster === null) next.delete(machine.id); else next.set(machine.id, roster);
          return next;
        });
      }));
    return () => { for (const unsubscribe of unsubscribers) unsubscribe(); };
  }, [db, uid, local.settled, machines]);

  /**
   * What a beat needs to know, held in a ref rather than read from the
   * closure. The effect below must re-run only when the *set of machines*
   * changes, and `watching` and `byMachine` change far more often than that
   * - `byMachine` is a fresh Map on every mirror update. Depending on them
   * restarted the interval and beat again each time, so a watched live turn
   * heartbeated every two seconds instead of every sixty: ~1,800 writes an
   * hour where the design budgets 60.
   */
  const beatState = useRef({ watching, byMachine, machines });
  beatState.current = { watching, byMachine, machines };

  /** Only the identity of the machines matters here, not the objects - a
   * fresh but value-identical array from a `lastSeen` touch must not
   * restart the interval. */
  const machineKey = machines.map((m) => m.id).join(",");

  // Presence: one heartbeat per remote machine, on a plain interval, only
  // while this tab is visible - see "Presence gates the mirror" in the
  // design. Announcing this page is the one thing it does unconditionally;
  // which session it is watching rides along, but only to the one machine
  // that session is actually on, so the right daemon mirrors its detail.
  useEffect(() => {
    if (db === null || uid === null || !local.settled || machineKey === "") return;
    const id = deviceId();

    const beat = () => {
      if (document.visibilityState !== "visible") return;
      const { watching: open, byMachine: rosters, machines: known } = beatState.current;
      const owner = open === null ? null : machineOwning(rosters, open);
      for (const machine of known) {
        void heartbeat(db, uid, machine.id, id, machine.id === owner ? open : null);
      }
    };

    /**
     * The way out, which nothing used to take. `stopWatching` has always
     * been here for it; with no caller, a phone going into a pocket and a
     * tab being closed both left the daemon mirroring into an empty room
     * for the full three-minute stale window. Withdrawing the entry
     * outright means the next poll - five seconds, not three minutes -
     * finds nobody and stands the mirror down.
     */
    const leave = () => {
      for (const machine of beatState.current.machines) void stopWatching(db, uid, machine.id, id);
    };

    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") beat();
      else leave();
    };

    beat();
    const timer = setInterval(beat, HEARTBEAT_MS);
    document.addEventListener("visibilitychange", onVisibilityChange);
    // `pagehide` rather than `beforeunload`: it is the one that fires when a
    // page goes into the back/forward cache, which is where a phone's tab
    // usually goes rather than being torn down.
    window.addEventListener("pagehide", leave);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("pagehide", leave);
    };
  }, [db, uid, local.settled, machineKey]);

  const rows = useMemo(() => {
    const now = Date.now();
    const flat: RosterRow[] = [];
    for (const [machineId, roster] of byMachine) {
      const machine = machines.find((m) => m.id === machineId);
      if (!machine || uid === null) continue;
      const asleep = machineIsAsleep(machine, now);
      for (const row of roster.rows) {
        flat.push({ ...row, machine: { id: machine.id, name: machine.name, asleep } });
        routeSession(row.id, { uid, machineId });
      }
    }
    return flat;
  }, [byMachine, machines, uid]);

  const wakingMachines = useMemo(() => {
    const now = Date.now();
    return machines.filter((m) => !machineIsAsleep(m, now) && !byMachine.has(m.id));
  }, [machines, byMachine]);

  const degradedMachines = useMemo(
    () => machines.filter((m) => byMachine.get(m.id)?.degraded === true),
    [machines, byMachine],
  );

  return { rows, uid, wakingMachines, degradedMachines };
}

/** Which of the currently-mirrored machines a session actually belongs to,
 * so a heartbeat's `watching` field never names a session to a machine that
 * does not have it. */
function machineOwning(byMachine: Map<string, MachineRoster>, sessionId: string): string | null {
  for (const [machineId, roster] of byMachine) {
    if (roster.rows.some((r) => r.id === sessionId)) return machineId;
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
  const watchedRow = rows.find((r) => r.id === watching) ?? null;
  useEffect(() => {
    setActiveMachine(watchedRow?.machine && remote.uid ? { uid: remote.uid, machineId: watchedRow.machine.id } : null);
  }, [watchedRow, remote.uid]);

  return {
    rows,
    live: local.live,
    wakingMachines: remote.wakingMachines,
    degradedMachines: remote.degradedMachines,
    activeMachineName: watchedRow?.machine?.name ?? null,
  };
}
