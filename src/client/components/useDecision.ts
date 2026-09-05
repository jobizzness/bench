import { useCallback, useEffect, useState } from "react";
import type { Decision, RosterRow } from "../../shared/types.js";
import { authFetch } from "../api.js";
import { seedAnswers, type Answers } from "../intake.js";
import { isWaiting } from "../waiting.js";

export interface DecisionState {
  decision: Decision | null;
  /** Whether the report behind the current key has been fetched at least
   * once - false while there is a key and its fetch has not answered
   * either way yet. `decision === null` used to mean both "still fetching"
   * and "fetched, and there genuinely isn't one" - `DecisionSheet.tsx` needs
   * the two told apart so it can hold the decision's shape for the first
   * one instead of drawing its bare header (#80). True with no key at all:
   * there is nothing pending, which is settled by definition. */
  settled: boolean;
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
  const [settled, setSettled] = useState(true);
  const [answers, setAnswers] = useState<Answers>({});
  const [choice, setChoice] = useState<string | null>(null);
  const [focus, setFocus] = useState(0);

  const id = row?.id ?? null;
  const seq = row?.latestReportSeq ?? null;
  const key = row && isWaiting(row) ? `${id}:${seq}` : null;

  useEffect(() => {
    if (key === null) { setDecision(null); setSettled(true); return; }

    setSettled(false);
    let cancelled = false;
    void (async () => {
      const res = await authFetch(`/api/sessions/${id}/report/${seq}`);
      const next: Decision | null = res.ok ? (await res.json()).decision : null;
      if (cancelled) return;
      setDecision(next);
      setAnswers(seedAnswers(next));
      setChoice(null);
      setFocus(0);
      setSettled(true);
    })();

    return () => { cancelled = true; };
    // Deliberately keyed on the report, not on the row object.
  }, [key]);

  const dismiss = useCallback(() => {
    setDecision(null);
    setChoice(null);
  }, []);

  return { decision, settled, answers, setAnswers, choice, setChoice, focus, setFocus, dismiss };
}
