import { useState } from "react";
import type { RosterRow } from "../../shared/types.js";
import { wantsAttention } from "../waiting.js";
import { projectName } from "../format.js";
import { inOrder, rememberOrder, savedOrder } from "../order.js";
import { hideProject } from "../hidden.js";
import { Row } from "./Row.js";
import { useRowOrder } from "./useRowOrder.js";

/**
 * One project's specialists, and the order they are drawn in.
 *
 * Two orders are possible and the developer chooses between them by acting.
 * Left alone, a group puts whoever is waiting on you first - several can need
 * you at once, and that ordering is what makes the next one findable. Drag a
 * row and the group is yours from then on: the arrangement you made is the
 * thing you are relying on, and a list that rearranged itself underneath it
 * would be no arrangement at all. The rail still says who is waiting, and so
 * does the count in the summary.
 */
export function RosterGroup({ project, rows, selectedId, open, onFold }: {
  project: string;
  rows: RosterRow[];
  selectedId: string | null;
  open: boolean;
  onFold: (open: boolean) => void;
}) {
  // Read once on the way in and kept here after that, so a roster arriving
  // over the socket does not send the page back to localStorage mid-drag.
  const [hand, setHand] = useState<string[] | null>(() => savedOrder()[project] ?? null);

  const settled = hand === null
    ? [...rows].sort((a, b) => Number(wantsAttention(b)) - Number(wantsAttention(a)))
    : inOrder(rows, hand);
  const { rows: drawn, held, take, nudge } = useRowOrder(settled, (ids) => {
    setHand(ids);
    rememberOrder(project, ids);
  });

  const waiting = rows.filter(wantsAttention).length;

  return (
    <details
      className="group"
      open={open}
      onToggle={(event) => onFold((event.currentTarget as HTMLDetailsElement).open)}
    >
      <summary title={project}>
        <span>{projectName(project)}</span>
        {/* On hover, in the gap the layout already leaves. A control that is
            always there is a control you read past every time, and this one
            is used about twice a month. */}
        <button
          type="button"
          className="hide-project"
          title={`Hide ${projectName(project)} from this roster`}
          aria-label={`Hide ${projectName(project)}`}
          onClick={(event) => {
            // Inside a summary, a click is a fold unless it is stopped.
            event.preventDefault();
            event.stopPropagation();
            hideProject(project);
          }}
        >
          hide
        </button>
        <span className="count" data-waiting={waiting > 0}>
          {waiting > 0 ? `${waiting} waiting` : String(rows.length)}
        </span>
      </summary>
      <ul className="group-rows" data-dragging={held !== null}>
        {drawn.map((row, index) => (
          <Row
            key={row.id}
            row={row}
            selected={row.id === selectedId}
            held={row.id === held}
            onTake={(event) => take(event, index)}
            onNudge={(by) => nudge(index, by)}
          />
        ))}
      </ul>
    </details>
  );
}
