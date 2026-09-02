import { useEffect, useState } from "react";
import type { PlanStep } from "../../daemon/plan.js";
import { authFetch, getSessionMachine } from "../api.js";
import { firestore } from "../firebase-app.js";
import { watchSessionMirror } from "../remote-roster.js";

/**
 * The specialist's own checklist, which it rewrites as it goes.
 *
 * Local session: unchanged from before #46 - polled every 2s only while its
 * turn is running, direct to the daemon. Relayed session: never polled.
 * `setInterval(read, 2000)` through a command is 60 writes a minute over the
 * relay - 3,600 an hour against a 20,000/day ceiling, enough to exhaust a
 * whole day's budget in six hours of watching one turn. The daemon already
 * mirrors the plan (`mirror-writer.ts`'s `readDetail`) for exactly this
 * reason, so a relayed session listens to that mirror document instead - no
 * poll, no command, one Firestore listener that only updates when the plan
 * actually changes.
 */
export function useSessionPlan(id: string | null, live: boolean): PlanStep[] | null {
  // Keyed by the specialist it came from, so keeping the last good copy
  // across a failed read cannot leak one specialist's checklist onto another.
  const [loaded, setLoaded] = useState<{ id: string | null; steps: PlanStep[] | null }>({ id: null, steps: null });
  const steps = loaded.id === id ? loaded.steps : null;
  const machine = id === null ? null : getSessionMachine(id);
  const machineKey = machine ? `${machine.uid}:${machine.machineId}` : null;

  useEffect(() => {
    if (!id) { setLoaded({ id: null, steps: null }); return; }

    if (machine !== null) {
      return watchSessionMirror(firestore(), machine.uid, machine.machineId, id, (detail) => {
        const plan = detail?.plan as { steps?: PlanStep[] } | null;
        setLoaded({ id, steps: plan?.steps ?? null });
      });
    }

    let cancelled = false;
    const read = async () => {
      try {
        const res = await authFetch(`/api/sessions/${id}/plan`);
        // A missed read is not an empty plan. This polls every two seconds
        // and the link drops several reads an hour, so blanking on failure
        // flickered the checklist away and back; the last good copy is the
        // honest thing to keep showing (#62).
        if (!cancelled && res.ok) setLoaded({ id, steps: (await res.json()).steps ?? null });
      } catch {
        // Left alone, for the same reason.
      }
    };

    void read();
    if (!live) return () => { cancelled = true; };

    const timer = setInterval(read, 2000);
    return () => { cancelled = true; clearInterval(timer); };
    // `machine` (not `machineKey`) is read above - the key is what decides
    // whether this effect re-runs, since a fresh but value-identical
    // `MachineRef` object from `useRoster.ts` must not resubscribe the
    // listener on every roster tick.
  }, [id, live, machineKey]);

  return steps;
}
