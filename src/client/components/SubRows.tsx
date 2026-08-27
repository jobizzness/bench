import type { RosterRow } from "../../shared/types.js";
import { wantsAttention } from "../waiting.js";
import { Row } from "./Row.js";

/** True for a row, or anything under it - however deep - that wants the
 * developer. Lights the spine for a branch that would otherwise need
 * scrolling past to notice. */
function branchWantsAttention(row: RosterRow, childrenOf: ReadonlyMap<string, RosterRow[]>): boolean {
  if (wantsAttention(row)) return true;
  return (childrenOf.get(row.id) ?? []).some((child) => branchWantsAttention(child, childrenOf));
}

/**
 * The tabs a specialist opened with `bench new`, drawn under it rather than
 * loose in the group.
 *
 * Recursive on purpose: a sub-agent can open its own. Each level indents one
 * step further and inherits the spine its parent is drawn from, so a glance
 * down the gutter says how deep a chain of delegation runs without counting
 * anything.
 *
 * Not draggable - see Row. A dropped-in order for a tree nobody asked to
 * reorder would be one more thing to get wrong for a case that will not come
 * up often enough to be worth it.
 */
export function SubRows({ parentId, childrenOf, selectedId }: {
  parentId: string;
  /** Every row in the group, by the id of whoever opened it. Built once per
   * roster update in RosterGroup, not per row - a map, not a filter run once
   * per specialist. */
  childrenOf: ReadonlyMap<string, RosterRow[]>;
  selectedId: string | null;
}) {
  const children = childrenOf.get(parentId);
  if (!children || children.length === 0) return null;

  // Same rule as the top level, on however many of these there are: whoever
  // wants you first is the one you see first.
  const ordered = [...children].sort((a, b) => Number(wantsAttention(b)) - Number(wantsAttention(a)));

  return (
    <ul className="sub-rows" data-waiting={ordered.some((child) => branchWantsAttention(child, childrenOf))}>
      {ordered.map((child) => (
        <Row key={child.id} row={child} selected={child.id === selectedId} nested>
          <SubRows parentId={child.id} childrenOf={childrenOf} selectedId={selectedId} />
        </Row>
      ))}
    </ul>
  );
}
