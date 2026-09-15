import { useEffect, useRef, useState } from "react";
import { postJson } from "../api.js";

/** What the last press did, or nothing if there has not been one. */
export type TargetOutcome = "idle" | "sending" | "sent" | "nobody" | "failed";

/** Long enough to read, short enough not to become part of the layout. */
const SETTLE_MS = 2500;

/**
 * Point whatever editors are listening at a project (#129).
 *
 * The outcome is held rather than fired and forgotten because the failure
 * that matters is silence: the developer opens VS Code themselves, so
 * "nothing was listening" is an ordinary state, and a button that looked the
 * same either way would be lying about the only case worth reporting.
 */
export function useTargetEditor(project: string): {
  outcome: TargetOutcome;
  target: () => void;
} {
  const [outcome, setOutcome] = useState<TargetOutcome>("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => () => clearTimeout(timer.current), []);

  const settle = (next: TargetOutcome) => {
    setOutcome(next);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setOutcome("idle"), SETTLE_MS);
  };

  const target = () => {
    setOutcome("sending");
    void postJson("/api/editor/target", { project })
      .then(async (res) => {
        if (!res.ok) { settle("failed"); return; }
        const { delivered } = (await res.json()) as { delivered: number };
        settle(delivered > 0 ? "sent" : "nobody");
      })
      .catch(() => settle("failed"));
  };

  return { outcome, target };
}
