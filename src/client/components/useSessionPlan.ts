import { useEffect, useState } from "react";
import type { PlanStep } from "../../daemon/plan.js";
import { authFetch } from "../api.js";

/**
 * The specialist's own checklist, which it rewrites as it goes. Polled only
 * while its turn is running: nothing else can change it, and the cockpit
 * should be quiet when a specialist is.
 */
export function useSessionPlan(id: string | null, live: boolean): PlanStep[] | null {
  const [steps, setSteps] = useState<PlanStep[] | null>(null);

  useEffect(() => {
    if (!id) { setSteps(null); return; }

    let cancelled = false;
    const read = async () => {
      try {
        const res = await authFetch(`/api/sessions/${id}/plan`);
        if (!cancelled) setSteps(res.ok ? (await res.json()).steps : null);
      } catch {
        if (!cancelled) setSteps(null);
      }
    };

    void read();
    if (!live) return () => { cancelled = true; };

    const timer = setInterval(read, 2000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [id, live]);

  return steps;
}
