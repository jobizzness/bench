import { useEffect, useState } from "react";
import { apiUrl, endpoint, token } from "../api.js";

/**
 * Which machine served this page, as that machine's own daemon knows it.
 *
 * This is what lets `useRoster.ts` tell "another machine on the account"
 * from "the machine I am already talking to directly". Without it every
 * signed-in cockpit heartbeated presence to its own daemon, which is a
 * viewer announcing itself to a machine that could already see it: the
 * daemon answers by running its whole watched loop - a presence poll every
 * five seconds, a command list every two, and the mirror - to publish a
 * roster this page had over the local socket before any of it was written.
 * That is 60,456 Firestore reads a day bought for nothing, and it is what
 * exhausted the daily quota.
 *
 * "Directly" rather than "locally" on purpose: a hosted cockpit pointed at a
 * daemon over the LAN reaches it with plain HTTP too (see `cors.ts`), so
 * that daemon is just as wrong to relay through Firestore as one on
 * `localhost`. Whatever `endpoint()` names is the machine to exclude.
 *
 * Deliberately a bare `fetch` rather than `authFetch`: `authFetch` routes
 * machine-global paths to whichever machine the open specialist is on (see
 * `machineFor` in `api.ts`), so with a remote session open it would relay
 * `/api/remote` to that machine and answer with *its* id - the exact machine
 * this needs to tell apart from the one serving the page.
 */
export interface LocalMachine {
  /** `null` when this page has no daemon of its own to ask, and when the
   * daemon it has has remote switched off - both mean "none of the machines
   * on the account is mine", so nothing is excluded. */
  id: string | null;
  /** Whether the question has been answered either way. Nothing subscribes
   * or heartbeats until it has, so the first beat cannot go out to a machine
   * that is about to turn out to be this one. */
  settled: boolean;
}

/**
 * `accountKey` is the set of machine ids currently on the account, and
 * asking again when it changes is what keeps this from going stale: turning
 * remote on from Settings mints this machine's id *after* the cockpit
 * mounted, and a page that only ever asked once would spend the rest of the
 * session heartbeating itself.
 */
export function useLocalMachineId(accountKey: string): LocalMachine {
  const [machine, setMachine] = useState<LocalMachine>({ id: null, settled: false });

  useEffect(() => {
    // Nothing served this page but static hosting, so there is no daemon to
    // ask and no round trip worth making to find that out. Settling here
    // rather than after a doomed request is what keeps the hosted cockpit -
    // the one most likely to be on a slow phone connection - from waiting on
    // a 404 before it subscribes to anything.
    if (endpoint() === null) { setMachine({ id: null, settled: true }); return; }

    let live = true;
    void (async () => {
      try {
        const res = await fetch(apiUrl("/api/remote"), { headers: { "x-bench-token": token() } });
        const id = res.ok ? ((await res.json()) as { machineId?: string | null }).machineId ?? null : null;
        if (live) setMachine({ id, settled: true });
      } catch {
        // The daemon is not answering. Excluding nothing is the safe way to
        // be wrong: the cost of relaying to a machine that turns out to be
        // this one is Firestore reads, where the cost of excluding a machine
        // that is genuinely remote is not seeing it at all.
        if (live) setMachine({ id: null, settled: true });
      }
    })();
    return () => { live = false; };
  }, [accountKey]);

  return machine;
}
