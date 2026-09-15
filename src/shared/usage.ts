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

/**
 * The windows we already have a short name for.
 *
 * A map rather than a rule, because "5-hour" and "7-day Opus" are what a
 * developer calls them, and no rule derives that from `seven_day_opus`.
 */
const KNOWN: Record<string, string> = {
  five_hour: "5-hour",
  seven_day: "7-day",
  seven_day_opus: "7-day Opus",
  seven_day_sonnet: "7-day Sonnet",
  seven_day_oauth_apps: "7-day apps",
};

/** A window's short name. Plain, but readable, for one nobody here has heard
 * of - it arrives on its own the day a new model gets a window of its own.
 * Shared because the usage endpoint and a specialist's own stream name the
 * same windows, and one bar must not be labelled two ways. */
export function windowLabel(key: string): string {
  return KNOWN[key]
    ?? key.replace(/^five_hour/, "5-hour").replace(/^seven_day/, "7-day").replace(/_/g, " ");
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

/**
 * The window closest to full.
 *
 * What the icon has to be honest about. Running out of the five-hour window
 * stops the work just as dead as running out of the week, so the mark carries
 * whichever is worst rather than an average - an average of one full window
 * and two empty ones is a number that has never been true of anything.
 *
 * Ties go to the first, which is the order the API named them in.
 */
export function fullest(windows: readonly UsageWindow[]): UsageWindow | null {
  return windows.reduce<UsageWindow | null>(
    (worst, window) => (worst === null || window.percent > worst.percent ? window : worst),
    null,
  );
}

/** How full the fullest window is. 0 for a key that has never been asked -
 * an unreadable number is not a reason to pass a key over. */
export function fullestPercent(windows: readonly UsageWindow[]): number {
  return fullest(windows)?.percent ?? 0;
}
