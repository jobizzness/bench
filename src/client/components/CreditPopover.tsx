import { Meter } from "./Meter.js";
import { CreditMark } from "./CreditMark.js";
import { useCredit } from "./useCredit.js";
import { creditPercent, creditSummary, money, type Credit } from "../../shared/credit.js";
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

  const percent = creditPercent(credit);

  return (
    <Meter said={creditSummary(credit)} mark={<CreditMark percent={percent} />} onOpen={() => void refresh()}>
      {credit.available ? <Spend credit={credit} percent={percent} /> : <p className="usage-note">{trouble(credit)}</p>}
    </Meter>
  );
}

/**
 * The money, and the ceiling as a bar where there is one.
 *
 * The number is printed whether or not the bar is: a bar alone puts the whole
 * reading on a length and a hue, and hue is what a colourblind developer or a
 * printed screenshot loses first.
 */
function Spend({ credit, percent }: {
  credit: Extract<Credit, { available: true }>;
  percent: number | null;
}) {
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
    </ul>
  );
}

/** Why there are no numbers, said as the thing to do about it. */
function trouble(credit: Extract<Credit, { available: false }>): string {
  return credit.reason === "refused"
    ? "That key was turned away — check it in Settings, or save a fresh one."
    : "Could not reach OpenRouter to ask. The key is fine as far as anyone here knows.";
}
