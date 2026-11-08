import { useCallback, useEffect, useState } from "react";
import { authFetch } from "../api.js";
import type { Usage } from "../../shared/usage.js";

/**
 * What the bench's credential has spent, as the daemon last answered.
 *
 * Asked when the cockpit opens, whenever the panel is opened, and on a slow
 * clock in between. The clock is what makes the mark worth colouring: an icon
 * that only refreshes when you point at it cannot warn you, because you point
 * at it to find out whether you needed warning.
 *
 * The daemon holds an answer for a minute, so a minute is as often as asking
 * can tell us anything new. A hidden tab is not asked at all - a cockpit left
 * open on another desktop for a week should not be polling all of it.
 *
 * Null is "not asked yet", which is not the same as "nothing to report" and
 * must not draw an icon.
 */
const EVERY = 60_000;

let inFlightUsage: Promise<Usage | null> | null = null;

async function fetchUsageOnce(): Promise<Usage | null> {
  if (inFlightUsage) return inFlightUsage;
  inFlightUsage = (async () => {
    try {
      const res = await authFetch("/api/usage");
      if (!res.ok) return null;
      return (await res.json()) as Usage;
    } catch {
      return null;
    } finally {
      inFlightUsage = null;
    }
  })();
  return inFlightUsage;
}

export function useUsage(): { usage: Usage | null; refresh: () => Promise<void> } {
  const [usage, setUsage] = useState<Usage | null>(null);

  const refresh = useCallback(async () => {
    const next = await fetchUsageOnce();
    if (next !== null) setUsage(next);
  }, []);

  useEffect(() => {
    let live = true;
    void (async () => {
      const next = await fetchUsageOnce();
      if (live && next !== null) setUsage(next);
    })();
    return () => { live = false; };
  }, []);

  useEffect(() => {
    const id = setInterval(() => {
      if (document.visibilityState === "hidden") return;
      void refresh();
    }, EVERY);
    return () => clearInterval(id);
  }, [refresh]);

  return { usage, refresh };
}
