import { Meter } from "./Meter.js";
import { CreditMark } from "./CreditMark.js";
import { useCredit } from "./useCredit.js";
import {
  balancePercent, creditPercent, creditSummary, limitPercent, money,
  type Balance, type Credit,
} from "../../shared/credit.js";
import { usageTone } from "../../shared/usage.js";

/**
 * What the OpenRouter key has spent, for a specialist billed there.
 *
 * The Anthropic meter is the wrong answer for these: a turn on Gemini never
 * touches the subscription, however full its windows are. This one reports
 * the account the turn is actually billed to.
 *
 * Absent entirely when the bench holds no OpenRouter key - which is every
 * bench that has never set one, and not a failure worth an icon.
 */
export function CreditPopover() {
  const { credit, refresh } = useCredit();

  if (credit === null || (!credit.available && credit.reason === "none")) return null;

  return (
    <Meter
      said={creditSummary(credit)}
      mark={<CreditMark percent={creditPercent(credit)} />}
      onOpen={() => void refresh()}
    >
      {credit.available ? <Spend credit={credit} /> : <p className="usage-note">{trouble(credit)}</p>}
    </Meter>
  );
}

/**
 * The money, and each ceiling as a bar where there is one.
 *
 * Two rows rather than one, because a key can have no limit and still be
 * nearly out of credit - the two are separate facts and collapsing them is
 * what let the panel say "no ceiling on this key" to an account with a dollar
 * on it. The limit row is drawn against the limit alone, so neither bar is
 * ever labelled with the other one's fraction.
 *
 * Every number is printed whether or not its bar is: a bar alone puts the
 * whole reading on a length and a hue, and hue is what a colourblind developer
 * or a printed screenshot loses first.
 */
function Spend({ credit }: { credit: Extract<Credit, { available: true }> }) {
  const percent = limitPercent(credit);

  return (
    <ul id="usage-list">
      <li className="usage-row" data-tone={percent === null ? undefined : usageTone(percent)}>
        <span className="usage-label">OpenRouter</span>
        <span className="usage-percent credit-amount">
          {credit.limit === null ? money(credit.spent) : `${money(credit.spent)} of ${money(credit.limit)} used`}
        </span>
        {percent !== null && (
          <span className="usage-track">
            <span className="usage-fill" style={{ width: `${percent}%` }} />
          </span>
        )}
        <span className="usage-reset">
          {credit.limit === null ? "no ceiling on this key" : `${percent}% of the ceiling`}
        </span>
      </li>
      {credit.balance && <Left balance={credit.balance} percent={balancePercent(credit)} />}
    </ul>
  );
}

/**
 * What is left of the credit the account bought.
 *
 * Says the remaining dollars first and the fraction second, because the bar
 * answers "how far through" and only the money answers "how much longer". A
 * developer reading this is deciding whether to top up before starting
 * something, and 98% is not a figure anyone can convert back into work.
 *
 * Absent when the balance could not be asked for, rather than drawn empty: an
 * unfilled track reads as plenty left, which is the reassuring lie again.
 */
function Left({ balance, percent }: { balance: Balance; percent: number | null }) {
  return (
    <li className="usage-row" data-tone={percent === null ? undefined : usageTone(percent)}>
      <span className="usage-label">Credit left</span>
      <span className="usage-percent credit-amount">
        {money(balance.remaining)} left of {money(balance.purchased)}
      </span>
      {percent !== null && (
        <span className="usage-track">
          <span className="usage-fill" style={{ width: `${percent}%` }} />
        </span>
      )}
      <span className="usage-reset">{percent === null ? "bought credit" : `${percent}% spent`}</span>
    </li>
  );
}

/** Why there are no numbers, said as the thing to do about it. */
function trouble(credit: Extract<Credit, { available: false }>): string {
  return credit.reason === "refused"
    ? "That key was turned away — check it in Settings, or save a fresh one."
    : "Could not reach OpenRouter to ask. The key is fine as far as anyone here knows.";
}
