import { dollars } from "../../shared/cost.js";
import type { Total } from "../../daemon/ledger.js";

/**
 * What one set of turns came to, with the two kinds of money kept apart.
 *
 * Two rows and never a sum. A plan turn went to Anthropic on a subscription
 * that was already bought, and its figure is what it would have cost at list
 * price - worth knowing, and not a bill anybody will send. An account turn is
 * cash that left the developer's OpenRouter balance today. Added together
 * they make a number that is true of nothing, so they are never added, and
 * each row says in words which of the two it is rather than trusting a label
 * like "plan" to carry it.
 */
export function SpendLedger({ total, scope }: {
  total: Total;
  /** What this set is - "This project", "Whole bench". Said on every row
   * rather than once above them, because the panel can show two of these and
   * a heading four rows up is not what a reader carries down the list. */
  scope: string;
}) {
  // A ledger with nothing in it is not a ledger with a problem, and it is
  // certainly not two rows of zeroes: `dollars(0)` says "free", which is the
  // right word for a model that costs nothing and the wrong one for a project
  // nobody has spent anything on yet.
  if (total.turns === 0) {
    return (
      <li className="usage-row">
        <span className="usage-label">{scope}</span>
        <span className="usage-percent credit-amount">nothing yet</span>
        <span className="usage-reset">no turn here has been billed</span>
      </li>
    );
  }

  return (
    <>
      <li className="usage-row">
        <span className="usage-label">{scope} · plan</span>
        <span className="usage-percent credit-amount">{amount(total.plan)}</span>
        <span className="usage-reset">on a subscription already paid for — not a bill</span>
      </li>
      <li className="usage-row">
        <span className="usage-label">{scope} · account</span>
        <span className="usage-percent credit-amount">{amount(total.account)}</span>
        <span className="usage-reset">cash out of your OpenRouter balance</span>
      </li>
      {total.estimated > 0 && <Guessed dollars={total.estimated} />}
      <li className="usage-row">
        <span className="usage-label">{scope} · turns</span>
        <span className="usage-percent credit-amount">{total.turns}</span>
        {/* The reason the ledger exists at all: the roster only knows about
            specialists that are still open, and closing one is the ordinary
            end of its life rather than an unusual event. */}
        <span className="usage-reset">closed specialists included</span>
      </li>
    </>
  );
}

/**
 * How much of the figures above is a guess rather than a settled charge.
 *
 * Absent entirely when nothing is estimated, rather than drawn as a zero: an
 * empty caveat is a caveat a reader has to stop and dismiss, and this panel
 * already asks for enough attention.
 *
 * Stated as an amount and not as a percentage, which is the one thing that
 * looks like an improvement here and is not. A share needs a denominator, and
 * the only denominator available is plan plus account - the sum this whole
 * panel exists to refuse. The daemon reports one estimated figure spanning
 * both kinds of money, so there is no honest fraction to print, and a
 * percentage of an illegitimate total would be a more confident-looking way
 * of saying something less true.
 *
 * The multiple is quoted because it is the whole reason anyone should care:
 * the guess is not noise around the real number, it is biased low, and a
 * developer deciding whether they can afford another afternoon needs to know
 * the figure leans their way.
 */
function Guessed({ dollars: guessed }: { dollars: number }) {
  return (
    <li className="usage-row">
      <span className="usage-label">of that, estimated</span>
      <span className="usage-percent credit-amount">{amount(guessed)}</span>
      <span className="usage-reset">
        a catalogue guess, not a settled charge — measured about 1.46× under
      </span>
    </li>
  );
}

/** Money as the rest of the cockpit says it, except for nought. "free" is
 * what `dollars` calls zero and it is right about a model's price; a total of
 * nothing spent is not free, it is nothing. Exported so the button's label and
 * the bench line say an amount exactly the way these rows do. */
export const amount = (value: number): string => (value === 0 ? "nothing" : dollars(value));
