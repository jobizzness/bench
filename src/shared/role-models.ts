import { DEFAULT_MODEL, isProxied } from "./models.js";
import type { Role } from "./roles.js";

/**
 * What each kind of work runs on unless somebody says otherwise.
 *
 * Every specialist used to start on Opus, because that was the only default
 * there was: `bench new` fell back to it and so did the picker. A reviewer
 * reading a diff and a researcher reading docs were billed at nineteen cents
 * a turn for work that costs one. The kind of work is the thing that decides
 * which model is right, and Bench already knows the kind of work - it is the
 * role on the tab.
 *
 * Two models each, and the second is not a detail. Most of these are reached
 * through OpenRouter, which needs a key and a balance; when there is neither,
 * the role falls back to something direct rather than quietly running Opus at
 * twenty times the price. A default that fails expensively and says nothing
 * is worse than no default.
 */
export interface RoleModel {
  /** What the work should run on. */
  preferred: string;
  /** What it runs on with no OpenRouter key - always an Anthropic alias, so
   * it works on the login this machine already has. */
  direct: string;
  /** Why this one, in the words the picker would use. */
  because: string;
}

export const ROLE_MODELS: Record<Role, RoleModel> = {
  // The general-purpose tab owns work from spec to done, planning included,
  // so it stays where it has always been.
  specialist: { preferred: "opus", direct: "opus", because: "Owns the whole job, planning included." },
  // Flagship only, and deliberately not through OpenRouter even though Opus
  // is listed there: routing it would move the spend off a subscription that
  // is already paid for and onto a card.
  planner: { preferred: "opus", direct: "opus", because: "Deciding what to build is the one place to spend the most." },
  implementer: {
    preferred: "openai/gpt-5.1-codex",
    direct: "sonnet",
    because: "A coding agent, and this turn has to compile.",
  },
  reviewer: {
    preferred: "openai/gpt-5.1-codex-mini",
    direct: "haiku",
    because: "Reads a diff and writes a paragraph. A twentieth of an Opus turn.",
  },
  researcher: {
    preferred: "deepseek/deepseek-v4-flash",
    direct: "haiku",
    because: "Reads a great deal and judges little, so the window matters more than the reasoning.",
  },
  assessor: {
    preferred: "google/gemini-3.1-pro-preview",
    direct: "opus",
    because: "A flagship from a different house, on the end-to-end view.",
  },
};

/**
 * The model a new specialist of this role should start on.
 *
 * The developer's own choice first, then the built-in, then whichever of the
 * two the bench can actually reach. Settings hold only what has been changed:
 * a table of five copied into a file is a table that stops following this one
 * the first time a model is renamed.
 */
export function modelForRole(
  role: Role,
  { chosen, viaRouter }: { chosen?: string | undefined; viaRouter: boolean },
): string {
  const wanted = chosen ?? ROLE_MODELS[role]?.preferred ?? DEFAULT_MODEL;
  if (!isProxied(wanted) || viaRouter) return wanted;
  // Asked for a proxied model with no key to reach it. Falling back is only
  // honest if it is said out loud - see `fellBack` and the note the dialog
  // draws from it.
  return ROLE_MODELS[role]?.direct ?? DEFAULT_MODEL;
}

/** Whether that answer is a substitute rather than what was asked for. */
export function fellBack(
  role: Role,
  options: { chosen?: string | undefined; viaRouter: boolean },
): boolean {
  const wanted = options.chosen ?? ROLE_MODELS[role]?.preferred ?? DEFAULT_MODEL;
  return isProxied(wanted) && !options.viaRouter;
}
