import { useCallback, useEffect, useState } from "react";
import type { Decision, RosterRow } from "../../shared/types.js";
import { authFetch } from "../api.js";
import { seedAnswers, type Answers } from "../intake.js";
import { isWaiting } from "../waiting.js";

export interface DecisionState {
  decision: Decision | null;
  answers: Answers;
  setAnswers: (next: Answers) => void;
  /** The chosen option on a plain decision; an intake keeps its own answers. */
  choice: string | null;
  setChoice: (id: string | null) => void;
  focus: number;
  setFocus: (index: number) => void;
  /** Take it off the screen once it has been sent, before the roster catches up. */
  dismiss: () => void;
}

/**
 * The decision waiting on the developer, if there is one.
 *
 * Keyed on the report rather than the row: the roster pushes constantly, and
 * reloading on every push threw away whatever had been chosen since the last
 * one — survivable when that was a single option, not when it is half an
 * intake. An answered decision is not a decision, so `isWaiting` gates it.
 */
export function useDecision(row: RosterRow | null): DecisionState {
  const [decision, setDecision] = useState<Decision | null>(null);
  const [answers, setAnswers] = useState<Answers>({});
  const [choice, setChoice] = useState<string | null>(null);
  const [focus, setFocus] = useState(0);

  const id = row?.id ?? null;
  const seq = row?.latestReportSeq ?? null;
  const key = row && isWaiting(row) ? `${id}:${seq}` : null;

  useEffect(() => {
    if (key === null) { setDecision(null); return; }

    let cancelled = false;
    void (async () => {
      const res = await authFetch(`/api/sessions/${id}/report/${seq}`);
      const next: Decision | null = res.ok ? (await res.json()).decision : null;
      if (cancelled) return;
      setDecision(next);
      setAnswers(seedAnswers(next));
      setChoice(null);
      setFocus(0);
    })();

    return () => { cancelled = true; };
    // Deliberately keyed on the report, not on the row object.
  }, [key]);

  const dismiss = useCallback(() => {
    setDecision(null);
    setChoice(null);
  }, []);

  return { decision, answers, setAnswers, choice, setChoice, focus, setFocus, dismiss };
}
