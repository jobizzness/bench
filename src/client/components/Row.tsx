import type { PointerEvent as ReactPointerEvent, ReactNode } from "react";
import type { RosterRow } from "../../shared/types.js";
import { useBenchActions } from "./context.js";
import { wantsAttention } from "../waiting.js";
import { Meta } from "./Meta.js";
import { GripMark } from "./GripMark.js";

/** One specialist in the roster: its name, its quiet line, and the two things
 * you can do to the row itself - move it, or close it. */
export function Row({ row, selected, held = false, onTake, onNudge, nested = false, children }: {
  row: RosterRow;
  selected: boolean;
  /** True while this is the row in the air. */
  held?: boolean;
  /**
   * Absent for a row `bench new` opened under another specialist. It is
   * drawn where its opener put it, not where the developer dragged it - so
   * there is no gesture for either of these to wire up, and no grip inviting
   * one.
   */
  onTake?: (event: ReactPointerEvent<HTMLElement>) => void;
  /** One place up (-1) or down (+1), from the keyboard. */
  onNudge?: (by: number) => void;
  /** True for a tab another specialist opened, drawn under it rather than
   * loose in the group. */
  nested?: boolean;
  /** That specialist's own openers, nested one level deeper still. */
  children?: ReactNode;
}) {
  const { select, closeSpecialist } = useBenchActions();

  return (
    // The list item wraps the row and, where there are any, its own nested
    // rows - but the row and its children are siblings inside it, not parent
    // and descendant. A `.row` that contained its children would put every
    // grandchild's close button inside its own `:hover` scope, and every
    // click on a grandchild would bubble through it and reselect it instead
    // of the row actually clicked.
    <li className="row-slot">
      <div
        className="row"
        data-status={row.status}
        // Status is not the same question as "does this want me". A specialist
        // that answered and wrote no report is awaiting_decision too, and the
        // roster was colouring it green while its own group count said nothing
        // was waiting. A tab held on another specialist's message wants you
        // too, and has no report to be the same kind of waiting as.
        data-waiting={wantsAttention(row)}
        data-held={held}
        data-nested={nested}
        aria-selected={selected}
        onClick={() => select(row.id)}
      >
        <div className="label">
          <span className="label-name">{row.label}</span>
          {/* Only ever set on a row from another machine's mirror - see
              "The merged roster" in the design. Absent means "here", so a
              roster with nothing broadcast from elsewhere looks exactly like
              it always has. */}
          {row.machine && (
            <span
              className="badge badge-machine"
              data-asleep={row.machine.asleep}
              title={row.machine.asleep ? `${row.machine.name} — asleep, showing its last-known state` : row.machine.name}
            >
              {row.machine.name}
            </span>
          )}
        </div>
        {/* Everything that is not its name, in one quiet line. The rail already
            says what the status is, in colour, so the word is not repeated
            here. */}
        <Meta row={row} />
        {/* A real button, not a decorated handle: dragging is a pointer gesture
            and the arrows are the same move for a hand that never leaves the
            keyboard. Only where there is an order to disturb. */}
        {onTake && onNudge && (
          <button
            type="button"
            className="grip"
            title="Drag to move — or ↑ ↓ once it has focus"
            aria-label={`Move ${row.label}`}
            onPointerDown={onTake}
            // The row underneath selects; taking hold of it must not.
            onClick={(event) => event.stopPropagation()}
            onKeyDown={(event) => {
              if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
              event.preventDefault();
              event.stopPropagation();
              onNudge(event.key === "ArrowUp" ? -1 : 1);
            }}
          >
            <GripMark />
          </button>
        )}
        <button
          type="button"
          className="close"
          title="Close this specialist"
          aria-label={`Close ${row.label}`}
          onClick={(event) => {
            // The row underneath selects a specialist; closing one must not.
            event.stopPropagation();
            closeSpecialist(row);
          }}
        >
          ×
        </button>
      </div>
      {children}
    </li>
  );
}
