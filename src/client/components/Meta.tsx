import { contextTone } from "../../shared/context-window.js";
import type { RosterRow } from "../../shared/types.js";
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
export function Meta({ row, status = false, branch = false, badges = false }: {
  row: RosterRow;
  /** The stage has no status rail to read the colour off, so it says it. */
  status?: boolean;
  branch?: boolean;
  /** Set the facts as badges rather than as one line. Header only. */
  badges?: boolean;
}) {
  const shared = !row.isolated && row.branch !== "";
  const tone = contextTone(row.context);
  // On the stage it is always worth knowing; on a row it is worth the space
  // only once it is close.
  const fill = status || branch || tone !== "ok";

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
      </div>
    );
  }

  return (
    <div className="meta meta-badges">
      <span className="badge badge-role">{row.role}</span>
      {status && <span className="badge">{row.status.replace(/_/g, " ")}</span>}
      {/* The only raised voice here, and the only one warranted: this
          specialist is editing the files you have open. */}
      {shared && <span className="badge badge-shared">in your checkout</span>}
      {branch && row.branch !== "" && <span className="badge badge-branch">{row.branch}</span>}
      {/* Outside the badges: it is a dial, not a label, and putting a ring in
          a bordered pill makes it look like one more thing to read. */}
      <span className="meta-detail">{row.detail}</span>
      {fill && <ContextMeter context={row.context} />}
    </div>
  );
}
