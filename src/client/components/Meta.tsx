import { contextTone } from "../../shared/context-window.js";
import { dollars } from "../../shared/cost.js";
import { modelLabel } from "../../shared/models.js";
import type { RosterRow } from "../../shared/types.js";
import { ClearContext } from "./ClearContext.js";
import { ContextMeter } from "./ContextMeter.js";

/**
 * The quiet line under a specialist's name: what kind it is, what it is doing,
 * and where.
 *
 * One line of one texture rather than a badge per fact. Four facts had become
 * four bordered chips in three invented colours, each with the visual weight
 * of a control - and a row where everything is emphasised has nothing
 * emphasised. Here the kind is read from the word, not from a hue.
 *
 * The header is the exception, and `badges` is what asks for it. That reason
 * was about a column of rows: twenty lines of chips is noise, one specialist's
 * header is not, and a header has the room to let a fact be a thing rather
 * than a clause. What the roster row keeps is a line.
 *
 * The role leads every line, so the left edge of the column tells you what
 * your bench is made of without reading a word of the rest.
 */
export function Meta({ row, status = false, branch = false, badges = false, onRole }: {
  row: RosterRow;
  /** The stage has no status rail to read the colour off, so it says it. */
  status?: boolean;
  branch?: boolean;
  /** Set the facts as badges rather than as one line. Header only. */
  badges?: boolean;
  /**
   * Opens the role picker. Header only, and only when there is one to open -
   * a roster row has no room for a control, and twenty of them would be
   * twenty things that look clickable in a column you scan.
   */
  onRole?: () => void;
}) {
  const shared = !row.isolated && row.branch !== "";
  // Absent on a row from a daemon that predates the field, and on nothing
  // else. Better a line without it than a line with the word "undefined".
  const model = row.model
    ? <span className="badge badge-model">{modelLabel(row.model)}</span>
    : null;
  const tone = contextTone(row.context);
  // On the stage it is always worth knowing; on a row it is worth the space
  // only once it is close.
  const fill = status || branch || tone !== "ok";

  // What it has cost, at the right edge of the row. It takes the place the
  // model badge held: the composer says the model on every screen where you
  // could act on it, and money is the fact you scan a roster for.
  const spent = row.spend
    ? <span className="badge badge-spend" data-billed={row.spend.billed}>{dollars(row.spend.dollars)}</span>
    : null;

  if (!badges) {
    // A roster row is 276px wide and this line has to fit the two things a
    // roster is for: which one this is, and whether it wants watching.
    //
    // "In your checkout" is not one of them. It is a standing fact about how
    // the specialist was made, not something that changes or that you act on
    // from the roster - and it was taking the room the detail needed on every
    // row it appeared on. The header says it, where there is space to say it
    // properly.
    return (
      <div className="meta">
        <span className="meta-role">{row.role}</span>
        <span className="meta-detail">{row.detail}</span>
        {fill && <ContextMeter context={row.context} />}
        {/* Held to the right edge rather than set in the run of the line:
            twenty rows put twenty of these in a column, and a column reads
            at a glance in a way a mid-sentence word does not. */}
        {spent ?? model}
      </div>
    );
  }

  // No model here. The header used to carry it, and the composer now says it
  // on the line where it is acted on - one screen saying the same word twice
  // is one of them saying nothing.
  return (
    <div className="meta meta-badges">
      {/* The role is changed where it is read, the way the name above it is.
          It was a word on a header and a word on a row and nothing else you
          could do anything about - and it is now the one fact here that
          changes how the agent behaves, so it had better be reachable. */}
      {onRole
        ? (
          <button
            type="button"
            id="stage-role"
            className="badge badge-role"
            title={`This agent is a ${row.role}. Change what it is.`}
            onClick={onRole}
          >
            {row.role}
          </button>
        )
        : <span className="badge badge-role">{row.role}</span>}
      {status && <span className="badge">{row.status.replace(/_/g, " ")}</span>}
      {/* What it has run up. On the header only: it is a fact you check when
          you are looking at one specialist, not one you scan a column for.
          The two kinds of money are told apart in the title rather than in a
          second badge - a plan turn is not a bill, and adding the two
          together would be inventing a number. */}
      {row.spend && (
        <span
          className="badge badge-spend"
          data-billed={row.spend.billed}
          title={row.spend.billed === "plan"
            ? `What its ${row.spend.turns} turns would have cost at list price. They were billed to your Claude plan.`
            : `What its ${row.spend.turns} turns cost, billed to your OpenRouter account.`}
        >
          {dollars(row.spend.dollars)}
        </span>
      )}
      {/* The only raised voice here, and the only one warranted: this
          specialist is editing the files you have open. */}
      {shared && <span className="badge badge-shared">in your checkout</span>}
      {branch && row.branch !== "" && <span className="badge badge-branch">{row.branch}</span>}
      {/* Outside the badges: it is a dial, not a label, and putting a ring in
          a bordered pill makes it look like one more thing to read. */}
      <span className="meta-detail">{row.detail}</span>
      {fill && <ContextMeter context={row.context} />}
      {/* The action on the dial beside it. Only when there is a conversation
          to forget: a "clear" with nothing to clear is a control that has to
          be read before it can be ignored, and it is read past on every row. */}
      {row.context && <ClearContext id={row.id} />}
    </div>
  );
}
