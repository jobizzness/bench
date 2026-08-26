/**
 * What a credential has spent, in the terms both ends need.
 *
 * The daemon fills these in from the API and the cockpit draws them. Shared
 * rather than duplicated because the tone thresholds are the one thing that
 * must not drift: a bar that turns red at ninety in one file and eighty in
 * another is a bar nobody trusts.
 */

/** One window, and how much of it is gone. */
export interface UsageWindow {
  /** The name the API gave it. Ours only for telling rows apart. */
  key: string;
  /** That name, short enough for a 15px row. */
  label: string;
  /** 0-100, whole. The bar's width, so it never exceeds the bar. */
  percent: number;
  /** When it turns over, as the API said it. Null when it did not say. */
  resetsAt: string | null;
}

export type Usage =
  | { available: true; windows: UsageWindow[] }
  /** Why there is nothing to draw. "none" is having no credential to ask
   * with, which is not a failure and is not worth saying out loud. */
  | { available: false; reason: "none" | "refused" | "unreachable" };

/**
 * How close to full is close enough to matter.
 *
 * The same three steps the context ring uses, for the same reason: a cockpit
 * that colours every number has no colour left for the one worth acting on.
 */
export type UsageTone = "ok" | "high" | "full";

export function usageTone(percent: number): UsageTone {
  if (percent >= 90) return "full";
  return percent >= 75 ? "high" : "ok";
}
