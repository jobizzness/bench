/**
 * What kind of agent a tab holds.
 *
 * A name, not a mechanism: every role runs the same way, with the same
 * permissions and the same model unless you choose otherwise. What it buys is
 * being able to look at the roster and see that three of these are building
 * and one is reading - which the label alone could only tell you if everybody
 * named their tabs carefully and kept doing it.
 */
export const ROLES = ["specialist", "implementer", "reviewer", "researcher"] as const;

export type Role = typeof ROLES[number];

/** What everything already on disk is, and what you get by saying nothing. */
export const DEFAULT_ROLE: Role = "specialist";

export function isRole(value: unknown): value is Role {
  return typeof value === "string" && (ROLES as readonly string[]).includes(value);
}

/** Anything unrecognised is a specialist rather than an error: a record
 * written before roles existed has no role, and neither does an old client. */
export function asRole(value: unknown): Role {
  return isRole(value) ? value : DEFAULT_ROLE;
}

/** One line each, shown where the role is chosen. They describe what you
 * would use it for, because that is the only thing that distinguishes them. */
export const ROLE_NOTE: Record<Role, string> = {
  specialist: "Owns a piece of work from spec to done. The default, and what everything before this was.",
  implementer: "Builds what a spec already describes. Point it at the file rather than retyping it.",
  reviewer: "Reads work someone else did and says what is wrong with it.",
  researcher: "Answers a question about the codebase. Reads, and reports what it found.",
};
