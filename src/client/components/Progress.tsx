import type { PlanStep } from "../../daemon/plan.js";
import { ago } from "../format.js";
import { progressVisible } from "../progress.js";
import { isWaiting } from "../waiting.js";
import { useBenchState } from "./context.js";
import { useSessionPlan } from "./useSessionPlan.js";
import { useTick } from "./useTick.js";

const MARK: Record<PlanStep["state"], string> = { done: "✓", doing: "▸", todo: "·" };

function Plan({ steps }: { steps: PlanStep[] }) {
  return (
    <ol id="plan">
      {steps.map((step, index) => (
        <li className="step" data-state={step.state} key={`${index}-${step.text}`}>
          <span className="mark">{MARK[step.state]}</span>
          <span>{step.text}</span>
        </li>
      ))}
    </ol>
  );
}

function Trail({ items }: { items: Array<{ at: string; text: string }> }) {
  return (
    <ul id="trail">
      {/* Newest first: what it is doing now is what you came to look at. */}
      {[...items].reverse().map((item) => (
        <li className="trail-item" key={`${item.at}-${item.text}`}>
          <span>{item.text}</span>
          <span className="when">{ago(item.at)}</span>
        </li>
      ))}
    </ul>
  );
}

/**
 * Two views of a running turn. The plan is what the specialist says it is
 * doing and can go stale; the trail is derived from its tool calls and
 * cannot. Showing both is what makes either trustworthy.
 */
export function Progress() {
  const { rows, selectedId } = useBenchState();
  const row = rows.find((r) => r.id === selectedId) ?? null;
  const live = row?.status === "working";
  const steps = useSessionPlan(row?.id ?? null, live);
  useTick(); // keeps the "ago" labels moving

  const trail = row?.activity ?? [];
  const visible = progressVisible({
    hasRow: row !== null,
    steps,
    trailLength: trail.length,
    decisionShowing: row !== null && isWaiting(row),
  });
  if (!visible) return null;

  return (
    <div id="progress">
      {steps && steps.length > 0 ? <Plan steps={steps} /> : <ol id="plan" />}
      <Trail items={trail} />
    </div>
  );
}
