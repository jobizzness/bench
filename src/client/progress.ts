import type { PlanStep } from "../daemon/plan.js";

export interface ProgressInput {
  /** A specialist is selected at all. */
  hasRow: boolean;
  /** The specialist's own checklist, or null when it has written none. */
  steps: PlanStep[] | null;
  /** Steps derived from tool calls. */
  trailLength: number;
  /** A decision is on screen, waiting to be answered. */
  decisionShowing: boolean;
}

/**
 * Whether to show what a specialist is doing.
 *
 * Not while a decision is waiting. Progress describes a turn in flight; a
 * decision means that turn has ended, so the checklist above it is stale by
 * definition - and it sits directly above the thing you are being asked. The
 * last line of a finished turn is not worth pushing the actual question down
 * the page for.
 */
export function progressVisible(input: ProgressInput): boolean {
  if (!input.hasRow) return false;
  if (input.decisionShowing) return false;
  return (input.steps?.length ?? 0) > 0 || input.trailLength > 0;
}
