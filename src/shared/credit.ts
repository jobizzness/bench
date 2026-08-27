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

/**
 * The credit the account has bought, and how much of it is still there.
 *
 * Deliberately not folded into `limit` below, because they are two different
 * ceilings and only one of them is usually set. A limit is a cap the developer
 * put on one key; a balance is money paid to OpenRouter that every key on the
 * account draws down. A pay-as-you-go key has no limit at all and can still be
 * a dollar from the work stopping, which is precisely the case that went
 * unreported for as long as the meter had only the limit to look at.
 *
 * Null where the balance could not be asked for - see openrouter.ts, which
 * reads it off a second route that is allowed to fail on its own.
 */
export interface Balance {
  /** Dollars bought on the account. */
  purchased: number;
  /** What is left of them. May go slightly negative: OpenRouter keeps
   * counting for a moment after the money runs out. */
  remaining: number;
}

export type Credit =
  | {
      available: true;
      /** Dollars spent on this key, as OpenRouter counts them. */
      spent: number;
      /** The ceiling the key was given, or null for one with none - a
       * pay-as-you-go key is the common case and is not an error. */
      limit: number | null;
      /** The account's purchased credit, or null when it could not be asked
       * for. Not knowing the balance is not the same as there being none. */
      balance: Balance | null;
    }
  /** Why there is nothing to draw. "none" is having no key to ask with, which
   * is not a failure and is not worth saying out loud. */
  | { available: false; reason: "none" | "refused" | "unreachable" };

/**
 * How much of the account's purchased credit is gone, 0-100 whole, or null
 * when the balance was not known.
 *
 * Measured against what was bought rather than against the key's own spend,
 * because the two are counted separately - other keys on the same account
 * spend the same money.
 */
export function balancePercent(credit: Credit): number | null {
  if (!credit.available || !credit.balance || credit.balance.purchased <= 0) return null;
  const gone = credit.balance.purchased - credit.balance.remaining;
  return whole((gone / credit.balance.purchased) * 100);
}

/**
 * How much of the key's own ceiling is gone, 0-100 whole, or null when there
 * is no ceiling to be a fraction of.
 */
export function limitPercent(credit: Credit): number | null {
  if (!credit.available || credit.limit === null || credit.limit <= 0) return null;
  return whole((credit.spent / credit.limit) * 100);
}

/**
 * The one number the mark carries: whichever of the two ceilings is nearer to
 * stopping the work.
 *
 * The same rule as the fullest window in shared/usage.ts, for the same reason.
 * Running out of purchased credit stops a turn just as dead as hitting the
 * key's limit, so a mark that averaged them - or that only ever looked at the
 * limit, which is how this file used to read - would be at its most reassuring
 * exactly when it was most wrong.
 */
export function creditPercent(credit: Credit): number | null {
  const both = [balancePercent(credit), limitPercent(credit)].filter((n) => n !== null);
  return both.length === 0 ? null : Math.max(...both);
}

/**
 * A fraction as a whole percentage of a bar that has to fit its track.
 *
 * Clamped, because either ceiling can be passed before OpenRouter stops
 * answering, and a bar wider than its track is a bar with its end cut off.
 */
function whole(percent: number): number {
  return Math.min(100, Math.max(0, Math.round(percent)));
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

/**
 * What the meter says about a key, whether or not it has a ceiling.
 *
 * The remaining balance leads where it is known, because it is the number
 * somebody has to do something about - a spend of $48.99 means nothing without
 * knowing what was bought, while "$1.01 left" is the whole of the news. The
 * spend is still drawn in the panel; this is the line read in passing, and it
 * gets the one fact that changes what the developer does next.
 */
export function creditSummary(credit: Credit): string {
  if (!credit.available) return "What this OpenRouter key has spent";
  if (credit.balance) {
    return `OpenRouter: ${money(credit.balance.remaining)} left of ${money(credit.balance.purchased)}`;
  }
  return credit.limit === null
    ? `OpenRouter: ${money(credit.spent)} spent`
    : `OpenRouter: ${money(credit.spent)} of ${money(credit.limit)} used`;
}
