import type { PlanStep } from "../../daemon/plan.js";
import { progressVisible } from "../progress.js";
import { Plan } from "./Plan.js";
import { Trail } from "./Trail.js";
import { useBenchState } from "./context.js";
import { useTick } from "./useTick.js";

/**
 * Two views of a running turn, at the top of the stage rather than crammed
 * under it. The plan is what the specialist says it is doing and can go
 * stale; the trail is derived from its tool calls and cannot. Showing both is
 * what makes either trustworthy — but only one of them is worth the room.
 */
export function Progress({ decisionShowing, steps }: {
  /** Whether a decision is taking room in the footer. An intake is a sheet
   * now, so it takes none - and the checklist can stay where it was. */
  decisionShowing: boolean;
  /** The specialist's checklist, fetched once above and shared with the
   * working strip, which draws a bar from it. */
  steps: PlanStep[] | null;
}) {
  const { rows, selectedId } = useBenchState();
  const row = rows.find((r) => r.id === selectedId) ?? null;
  const live = row?.status === "working";
  useTick(); // keeps the "ago" labels moving

  const trail = row?.activity ?? [];
  const visible = progressVisible({
    hasRow: row !== null,
    steps,
    trailLength: trail.length,
    decisionShowing,
  });
  if (!visible) return null;

  return (
    <section id="progress" data-live={live}>
      {steps && <Plan steps={steps} />}
      <Trail items={trail} />
    </section>
  );
}
