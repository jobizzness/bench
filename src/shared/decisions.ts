import type { Decision, DecisionOption } from "./types.js";

/**
 * A spec has two answers before it has any of its own.
 *
 * When an agent asks for a plan to be approved, the options it writes are the
 * forks inside the plan - which storage, which expiry. None of them is the
 * answer the developer most often wants to give, which is yes build it, or no
 * do not. Those were only ever available as free text, and a decision whose
 * commonest answer needs typing is a decision that gets typed badly.
 *
 * The agent's own options follow, because a spec can be approved *and* have a
 * fork settled in the same breath.
 */
export const APPROVE: DecisionOption = {
  id: "approved",
  label: "Approve",
  hint: "Build it as described.",
};

export const REJECT: DecisionOption = {
  id: "rejected",
  label: "Reject",
  hint: "Do not build this. Say what is wrong in your own words.",
};

export function answersFor(decision: Decision): DecisionOption[] {
  return decision.kind === "spec_approval"
    ? [APPROVE, REJECT, ...decision.options]
    : decision.options;
}
