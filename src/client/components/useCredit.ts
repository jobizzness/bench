import { useCallback, useEffect, useState } from "react";
import { authFetch } from "../api.js";
import type { Credit } from "../../shared/credit.js";

/**
 * What the bench's OpenRouter key has spent, as the daemon last answered.
 *
 * The same rhythm as useUsage: asked when the meter mounts, again whenever
 * the panel is opened, and on a slow clock in between. The clock is what
 * makes the mark worth colouring - a mark that only refreshes when you point
 * at it cannot warn you, because you point at it to find out whether you
 * needed warning.
 *
 * Only mounted for a specialist that is actually billed to OpenRouter, so a
 * bench that never leaves Anthropic never asks at all.
 *
 * Null is "not asked yet", which is not the same as "nothing to report" and
 * must not draw a mark.
 */
const EVERY = 60_000;

let inFlightCredit: Promise<Credit | null> | null = null;

async function fetchCreditOnce(): Promise<Credit | null> {
  if (inFlightCredit) return inFlightCredit;
  inFlightCredit = (async () => {
    try {
      const res = await authFetch("/api/openrouter/usage");
      if (!res.ok) return null;
      return (await res.json()) as Credit;
    } catch {
      return null;
    } finally {
      inFlightCredit = null;
    }
  })();
  return inFlightCredit;
}

export function useCredit(): { credit: Credit | null; refresh: () => Promise<void> } {
  const [credit, setCredit] = useState<Credit | null>(null);

  const refresh = useCallback(async () => {
    const next = await fetchCreditOnce();
    if (next !== null) setCredit(next);
  }, []);

  useEffect(() => {
    let live = true;
    void (async () => {
      const next = await fetchCreditOnce();
      if (live && next !== null) setCredit(next);
    })();
    return () => { live = false; };
  }, []);

  useEffect(() => {
    const id = setInterval(() => {
      // A cockpit left open on another desktop for a week should not be
      // polling all of it.
      if (document.visibilityState === "hidden") return;
      void refresh();
    }, EVERY);
    return () => clearInterval(id);
  }, [refresh]);

  return { credit, refresh };
}
