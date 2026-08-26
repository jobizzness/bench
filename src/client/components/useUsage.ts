import { useCallback, useEffect, useState } from "react";
import { authFetch } from "../api.js";
import type { Usage } from "../../shared/usage.js";

/**
 * What the bench's credential has spent, as the daemon last answered.
 *
 * Asked once when the cockpit opens, so the header knows whether it has
 * anything to offer, and again whenever the panel is opened - a cockpit left
 * up all day would otherwise show this morning's numbers. The daemon holds an
 * answer for a minute, so re-asking on every hover costs nothing.
 *
 * Null is "not asked yet", which is not the same as "nothing to report" and
 * must not draw an icon.
 */
export function useUsage(): { usage: Usage | null; refresh: () => Promise<void> } {
  const [usage, setUsage] = useState<Usage | null>(null);

  const refresh = useCallback(async () => {
    const res = await authFetch("/api/usage");
    if (!res.ok) return;
    setUsage(await res.json());
  }, []);

  useEffect(() => {
    let live = true;
    void (async () => {
      const res = await authFetch("/api/usage");
      if (!live || !res.ok) return;
      setUsage(await res.json());
    })();
    return () => { live = false; };
  }, []);

  return { usage, refresh };
}
