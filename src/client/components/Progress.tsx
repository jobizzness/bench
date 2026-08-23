import { progressVisible } from "../progress.js";
import { Plan } from "./Plan.js";
import { Trail } from "./Trail.js";
import { useBenchState } from "./context.js";
import { useSessionPlan } from "./useSessionPlan.js";
import { useTick } from "./useTick.js";

/**
 * Two views of a running turn, at the top of the stage rather than crammed
 * under it. The plan is what the specialist says it is doing and can go
 * stale; the trail is derived from its tool calls and cannot. Showing both is
 * what makes either trustworthy — but only one of them is worth the room.
 */
export function Progress({ decisionShowing }: {
  /** Whether a decision is taking room in the footer. An intake is a sheet
   * now, so it takes none - and the checklist can stay where it was. */
  decisionShowing: boolean;
}) {
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
