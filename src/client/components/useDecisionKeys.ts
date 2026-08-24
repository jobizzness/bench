import { useEffect } from "react";
import type { Decision } from "../../shared/types.js";
import { answersFor } from "../../shared/decisions.js";
import { isAnswered, splitQuestions, type Answers } from "../intake.js";

export interface KeyHandlers {
  decision: Decision | null;
  answers: Answers;
  focus: number;
  setFocus: (index: number) => void;
  pick: (questionId: string, optionId: string) => void;
  choose: (optionId: string) => void;
  submit: () => void;
  typeInstead: () => void;
}

/**
 * Read it, press one key.
 *
 * Bound to the document rather than a container, so the keys work without
 * clicking into anything first. Every question owns a text box, so the guard
 * is "am I typing", not "am I in the composer".
 */
export function useDecisionKeys(handlers: KeyHandlers): void {
  useEffect(() => {
    const {
      decision, answers, focus, setFocus, pick, choose, submit, typeInstead,
    } = handlers;
    if (!decision) return;

    const onKey = (event: KeyboardEvent) => {
      const target = event.target;
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return;

      const number = Number(event.key) - 1;

      if (decision.questions.length > 0) {
        const { open } = splitQuestions(decision);
        if (open.length === 0) return;
        const focused = open[Math.min(focus, open.length - 1)];

        if (Number.isInteger(number) && number >= 0 && number < focused.options.length) {
          event.preventDefault();
          pick(focused.id, focused.options[number].id);
          return;
        }

        const step = event.key === "ArrowDown" || event.key === "j" ? 1
          : event.key === "ArrowUp" || event.key === "k" ? -1 : 0;
        if (step !== 0) {
          event.preventDefault();
          setFocus(Math.max(0, Math.min(focus + step, open.length - 1)));
          return;
        }

        if (event.key === "Enter") {
          event.preventDefault();
          // Refusing silently would look broken. Jump to what is actually
          // blocking instead, and let the chip explain itself.
          const stuck = open.findIndex((q) => !isAnswered(answers, q));
          if (stuck === -1) submit();
          else setFocus(stuck);
          return;
        }
        if (event.key === "/") { event.preventDefault(); typeInstead(); }
        return;
      }

      // The list the buttons draw, which for a spec begins with approve and
      // reject rather than with whatever the agent wrote.
      const choices = answersFor(decision);
      if (Number.isInteger(number) && number >= 0 && number < choices.length) {
        choose(choices[number].id);
        return;
      }
      if (event.key === "Enter") { event.preventDefault(); submit(); }
      if (event.key === "/") { event.preventDefault(); typeInstead(); }
    };

    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
    // No dependency array on purpose. The handler closes over focus, answers
    // and the decision; a stale closure here is a key that quietly does the
    // wrong thing, and swapping one listener per render costs nothing.
  });
}
