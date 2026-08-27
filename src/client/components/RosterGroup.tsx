import { useMemo, useState } from "react";
import type { RosterRow } from "../../shared/types.js";
import { wantsAttention } from "../waiting.js";
import { projectName } from "../format.js";
import { inOrder, rememberOrder, savedOrder } from "../order.js";
import { hideProject } from "../hidden.js";
import { Row } from "./Row.js";
import { SubRows } from "./SubRows.js";
import { useRowOrder } from "./useRowOrder.js";

/** Every row in the group, by the id of whoever opened it with `bench new`.
 * A row whose opener has since closed - or was never in this group, which a
 * restored roster cannot rule out - has nobody to nest under, so it is left
 * out: that row surfaces at the top level instead, rather than vanishing. */
function childrenByOpener(rows: RosterRow[]): Map<string, RosterRow[]> {
  const ids = new Set(rows.map((row) => row.id));
  const map = new Map<string, RosterRow[]>();
  for (const row of rows) {
    if (row.createdBy === null || !ids.has(row.createdBy)) continue;
    const siblings = map.get(row.createdBy);
    if (siblings) siblings.push(row);
    else map.set(row.createdBy, [row]);
  }
  return map;
}

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

  // What is under what. A tab another specialist opened is drawn nested under
  // it rather than as one more thing in this list - see childrenByOpener -
  // so only the rows nobody opened take part in the ordering below.
  const childrenOf = useMemo(() => childrenByOpener(rows), [rows]);
  const nestedIds = useMemo(() => new Set([...childrenOf.values()].flat().map((row) => row.id)), [childrenOf]);
  const roots = rows.filter((row) => !nestedIds.has(row.id));

  const settled = hand === null
    ? [...roots].sort((a, b) => Number(wantsAttention(b)) - Number(wantsAttention(a)))
    : inOrder(roots, hand);
  const { rows: drawn, held, take, nudge } = useRowOrder(settled, (ids) => {
    setHand(ids);
    rememberOrder(project, ids);
  });

  // Everyone who wants you, nested or not - the count in the summary is a
  // promise about the whole group, not just its top level.
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
          >
            <SubRows parentId={row.id} childrenOf={childrenOf} selectedId={selectedId} />
          </Row>
        ))}
      </ul>
    </details>
  );
}
