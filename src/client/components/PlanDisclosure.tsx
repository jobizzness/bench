import { useState } from "react";
import type { Activity } from "../../daemon/activity.js";
import type { PlanStep } from "../../daemon/plan.js";
import { Plan } from "./Plan.js";
import { Trail } from "./Trail.js";

/**
 * The checklist and its trail, folded behind one tap on a phone (#100).
 *
 * Above 720px this is inert - the toggle is hidden by `styles.css`'s base
 * rule and `#plan-collapse` is a plain block there, so `expanded` never
 * has anything to do and the panel renders exactly as it always has.
 *
 * The label names the step actually being worked, not a count: `Working`'s
 * strip a few pixels away already says "2 of 5 · 3m 16s", so a collapsed
 * header that repeated the count would be duplicating a fact that is
 * already on screen. It would also be wrong to lean on that strip as the
 * only way to reach this panel, the way a first read of #100 suggests -
 * `Working` only renders while a turn is actually running or a worktree is
 * being provisioned, and this panel outlives that: a finished turn with a
 * leftover plan (or one waiting on a decision that opened as a sheet
 * rather than the footer) still shows a checklist with no `Working` strip
 * anywhere on the page. This panel needs its own tap target regardless,
 * so it has one, and its label is this panel's own fact - which step is
 * current - rather than a shadow of a strip that is not always there.
 *
 * `key={selectedId}` at the call site (`Progress.tsx`) resets `expanded`
 * to its default by remounting this component rather than by an effect: a
 * fresh mount starts at rest with no prior value to transition from, so
 * switching specialists collapses the panel instantly instead of
 * animating it shut.
 */
export function PlanDisclosure({ steps, trail }: {
  /** The specialist's own checklist, or null when it has written none. */
  steps: PlanStep[] | null;
  /** Steps derived from tool calls. */
  trail: Activity[];
}) {
  const [expanded, setExpanded] = useState(false);

  const doing = steps?.find((step) => step.state === "doing");
  const label = doing ? doing.text : "Checklist";

  return (
    <>
      <button
        type="button"
        id="plan-toggle"
        aria-expanded={expanded}
        aria-controls="plan-collapse"
        onClick={() => setExpanded((was) => !was)}
      >
        <span id="plan-toggle-mark" aria-hidden="true" />
        <span id="plan-toggle-label">{label}</span>
      </button>
      <div id="plan-collapse" data-expanded={expanded}>
        <div className="plan-collapse-inner">
          {steps && <Plan steps={steps} />}
          <Trail items={trail} />
        </div>
      </div>
    </>
  );
}
