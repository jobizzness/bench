/**
 * What an OpenRouter account has spent, in the terms both ends need.
 *
 * A sibling of shared/usage.ts and deliberately not the same shape. An
 * Anthropic subscription is windows that refill - five hours, a week - and
 * the only question worth asking is how full the fullest one is. An
 * OpenRouter account is money: it is spent, not filled, and it may have no
 * ceiling at all. Forcing the second into the first would mean inventing a
 * percentage for an account that has no limit set, which is a number that has
 * never been true of anything.
 */

export type Credit =
  | {
      available: true;
      /** Dollars spent on this key, as OpenRouter counts them. */
      spent: number;
      /** The ceiling the key was given, or null for one with none - a
       * pay-as-you-go key is the common case and is not an error. */
      limit: number | null;
    }
  /** Why there is nothing to draw. "none" is having no key to ask with, which
   * is not a failure and is not worth saying out loud. */
  | { available: false; reason: "none" | "refused" | "unreachable" };

/**
 * How much of the ceiling is gone, 0-100 whole, or null when there is no
 * ceiling to be a fraction of.
 *
 * Clamped, because a key can be spent past its limit before OpenRouter stops
 * answering for it, and a bar wider than its track is a bar with its end cut
 * off.
 */
export function creditPercent(credit: Credit): number | null {
  if (!credit.available || credit.limit === null || credit.limit <= 0) return null;
  return Math.min(100, Math.max(0, Math.round((credit.spent / credit.limit) * 100)));
}

/**
 * The money, as a line someone reads in passing.
 *
 * Two decimals throughout rather than only where they are needed: a column of
 * "$12.40" and "$8" does not read as two amounts of the same kind, and this
 * number sits directly beside a model name that is already asking to be
 * compared.
 */
export function money(amount: number): string {
  return `$${amount.toFixed(2)}`;
}

/** What the meter says about a key, whether or not it has a ceiling. */
export function creditSummary(credit: Credit): string {
  if (!credit.available) return "What this OpenRouter key has spent";
  return credit.limit === null
    ? `OpenRouter: ${money(credit.spent)} spent`
    : `OpenRouter: ${money(credit.spent)} of ${money(credit.limit)} used`;
}
