import type { PlanStep } from "../../daemon/plan.js";

const MARK: Record<PlanStep["state"], string> = { done: "✓", doing: "▸", todo: "·" };

/**
 * The specialist's own checklist — the answer to "where has this got to",
 * which is the question the cockpit exists for. It is rendered only when
 * there is one: an empty checklist reads as nothing left to do, which is the
 * opposite of what a specialist that has not written a plan means.
 */
export function Plan({ steps }: { steps: PlanStep[] }) {
  if (steps.length === 0) return null;

  return (
    <ol id="plan">
      {steps.map((step, index) => (
        <li className="step" data-state={step.state} key={`${index}-${step.text}`}>
          <span className="mark" aria-hidden="true">{MARK[step.state]}</span>
          <span className="what">{step.text}</span>
        </li>
      ))}
    </ol>
  );
}
