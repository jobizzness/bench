import type { SessionStatus } from "../shared/types.js";

export interface TurnOutcome {
  status: SessionStatus;
  detail: string;
}

/**
 * What the roster should say once a turn ends. Kept separate from the
 * registry so the awkward case - a failed turn - is stated once and can be
 * tested. Whether a turn produced a report is the agent's call, so a turn
 * without one is ordinary rather than a fault.
 */
export function resolveTurnOutcome(input: {
  isError: boolean;
  subtype: string;
  hasNewReport: boolean;
}): TurnOutcome {
  if (input.isError) {
    return { status: "crashed", detail: `turn failed: ${input.subtype}` };
  }

  if (input.hasNewReport) {
    return { status: "awaiting_decision", detail: "waiting on you" };
  }

  return { status: "awaiting_decision", detail: "replied" };
}
