import type { SessionStatus, TurnKind } from "../shared/types.js";

export interface TurnOutcome {
  status: SessionStatus;
  detail: string;
}

/**
 * What the roster should say once a turn ends. Kept separate from the
 * registry so the awkward cases - a failed turn, a work turn that somehow
 * produced no report - are stated once and can be tested.
 */
export function resolveTurnOutcome(input: {
  isError: boolean;
  subtype: string;
  kind: TurnKind;
  hasNewReport: boolean;
}): TurnOutcome {
  if (input.isError) {
    return { status: "crashed", detail: `turn failed: ${input.subtype}` };
  }

  if (input.hasNewReport) {
    return { status: "awaiting_decision", detail: "waiting on you" };
  }

  if (input.kind === "chat") {
    return { status: "awaiting_decision", detail: "replied" };
  }

  // A work turn with no report should be impossible now that turn markers
  // advance at turn start. Saying so plainly beats claiming a decision is
  // waiting when there is nothing to read.
  return { status: "awaiting_decision", detail: "ended without a report" };
}
