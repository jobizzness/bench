import { Meter } from "./Meter.js";
import { SpendMark } from "./SpendMark.js";
import { SpendLedger, amount } from "./SpendLedger.js";
import { useSpend } from "./useSpend.js";
import type { Total } from "../../daemon/ledger.js";

/**
 * What has already been spent, at the end of the composer beside what there
 * is left to spend.
 *
 * The meters next to this one answer "how much is left"; this one answers
 * "what has this cost", and they are not the same question - a subscription
 * window that has refilled says nothing about the four hundred turns that
 * went through it last week. It is mounted whatever the specialist runs on,
 * because unlike those two it is not about one account: both kinds of money
 * are in it, and which one the next turn will use does not change what the
 * last hundred already did.
 *
 * Scoped to the open specialist's project, because that is the question a
 * developer actually has - what has this piece of work cost - and the bench
 * total is a number they can do nothing with. The whole bench is one line
 * further down rather than behind a control: it is a fact to notice in
 * passing, and a toggle here would be a second thing to operate inside a
 * panel that only exists for as long as a pointer rests on it.
 */
export function SpendPopover({ project }: {
  /** The absolute path of the open specialist's project. Absent when no
   * specialist is selected, which leaves the whole bench as the only scope
   * there is. */
  project?: string;
}) {
  const { spending, refresh } = useSpend(project);

  // Not asked yet. The same silence useUsage keeps, and for the same reason:
  // a meter that appears empty and fills in a moment later reads as a bench
  // that has spent nothing.
  if (spending === null) return null;

  if (!spending.known) {
    return (
      <Meter
        id="spend"
        said="What this has spent — the ledger could not be read"
        mark={<SpendMark />}
        onOpen={() => void refresh()}
      >
        {/* Said as a gap in what we know rather than as zero. Every other
            failure in this footer resolves to a number the developer can
            ignore; this one must not, because "nothing spent" is exactly the
            comfortable answer a broken ledger would give. */}
        <p className="usage-note">
          Could not read the spend ledger. This is not a bench that has spent nothing — it is a
          question that went unanswered.
        </p>
      </Meter>
    );
  }

  // The narrower of the two is what the button is about: you are looking at a
  // specialist, so the figure beside it should be that specialist's project.
  const near = spending.project ?? spending.bench;
  const scope = spending.project === null ? "whole bench" : "this project";
  const wider = spending.project !== null && !same(spending.project, spending.bench)
    ? spending.bench
    : null;

  return (
    <Meter
      id="spend"
      said={summary(near, scope)}
      mark={<SpendMark estimated={near.estimated > 0} />}
      onOpen={() => void refresh()}
    >
      <ul id="spend-list">
        <SpendLedger total={near} scope={scope} />
        {wider && <Wider total={wider} />}
      </ul>
    </Meter>
  );
}

/**
 * What every project on the bench comes to, under the one being looked at.
 *
 * One line rather than the four the project gets. It is here so the total is
 * reachable without going and finding another screen, not so it can be
 * studied - and repeating the full breakdown twice in a panel this narrow
 * would bury the figure the developer opened it for.
 *
 * Absent when the two are the same, which is every bench with one project on
 * it. Printing the same numbers twice under two different headings invites
 * the reader to look for the difference.
 */
function Wider({ total }: { total: Total }) {
  return (
    <li className="usage-row">
      <span className="usage-label">whole bench</span>
      <span className="usage-percent credit-amount">
        {total.turns === 0 ? "nothing yet" : `${total.turns} turns`}
      </span>
      {total.turns > 0 && (
        <span className="usage-reset">
          {amount(total.plan)} on plan · {amount(total.account)} from your account
        </span>
      )}
    </li>
  );
}

/**
 * The whole answer in a sentence, for a pointer resting on the button and for
 * a screen reader passing over it.
 *
 * Both kinds of money named as what they are rather than as "plan" and
 * "account", because this string is read on its own with none of the panel's
 * rows around it to explain them. The estimate is carried here too: the mark
 * can only say that some of the figure is a guess, and how much of it is the
 * part worth acting on.
 */
function summary(total: Total, scope: string): string {
  if (total.turns === 0) return `Spend on ${scope}: nothing billed yet`;

  const said = `Spend on ${scope}: ${amount(total.plan)} on plan`
    + `, ${amount(total.account)} from your account`
    + `, across ${total.turns} turn${total.turns === 1 ? "" : "s"}`;
  return total.estimated > 0 ? `${said} — ${amount(total.estimated)} of that estimated` : said;
}

/** Whether the project has the bench entirely to itself. */
const same = (a: Total, b: Total): boolean =>
  a.plan === b.plan && a.account === b.account && a.turns === b.turns && a.estimated === b.estimated;
