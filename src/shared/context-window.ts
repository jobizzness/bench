/**
 * How full a specialist's conversation is.
 *
 * Not the same question as what a turn cost. The tokens on the working strip
 * are this turn's; this is the whole conversation, and it is the number that
 * decides whether a specialist is worth prompting again or worth replacing.
 * A conversation near its window will start dropping the beginning of itself,
 * and the developer is the only one who can act on that.
 */
export interface Context {
  /** What the last request actually sent: fresh input, plus cache written and
   * cache read. Cached tokens are still in the window. */
  used: number;
  /** The model's own limit, as the CLI reports it - never a number of ours,
   * because the windows differ per model and change without us. */
  window: number;
}

export function fractionUsed(context: Context | null): number | null {
  if (!context || context.window <= 0) return null;
  return Math.min(1, context.used / context.window);
}

/**
 * Quiet until it matters. Below three quarters this is a number nobody needs
 * to act on, and a cockpit that colours every fact has no colour left for the
 * one that counts.
 */
export type ContextTone = "ok" | "high" | "full";

export function contextTone(context: Context | null): ContextTone {
  const fraction = fractionUsed(context);
  if (fraction === null) return "ok";
  if (fraction >= 0.9) return "full";
  return fraction >= 0.75 ? "high" : "ok";
}
