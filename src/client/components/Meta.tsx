import type { RosterRow } from "../../shared/types.js";

/**
 * The quiet line under a specialist's name: what kind it is, what it is doing,
 * and where.
 *
 * One line of one texture rather than a badge per fact. Four facts had become
 * four bordered chips in three invented colours, each with the visual weight
 * of a control - and a row where everything is emphasised has nothing
 * emphasised. Here the kind is read from the word, not from a hue; the only
 * colour is the one exception worth raising a voice for.
 *
 * The role leads every line, so the left edge of the column tells you what
 * your bench is made of without reading a word of the rest.
 */
export function Meta({ row, status = false, branch = false }: {
  row: RosterRow;
  /** The stage has no status rail to read the colour off, so it says it. */
  status?: boolean;
  branch?: boolean;
}) {
  const shared = !row.isolated && row.branch !== "";
  // A roster row is 276px wide and this line has to fit the two things a
  // roster is for: which one this is, and whether it wants watching. What it
  // is doing is the third of those, and it is one click away on the stage -
  // so when there is a warning to make room for, the detail is what goes.
  const room = !shared || status || branch;

  return (
    <div className="meta">
      <span className="meta-role">{row.role}</span>
      {status && <span>{row.status.replace(/_/g, " ")}</span>}
      {/* Before the detail rather than after it: the detail is the segment
          that gives way when the line runs out of room, and a warning that
          can be squeezed off the end is not a warning. */}
      {shared && <span className="meta-shared">in your checkout</span>}
      {room && <span className="meta-detail">{row.detail}</span>}
      {branch && row.branch !== "" && <span className="meta-branch">{row.branch}</span>}
    </div>
  );
}
