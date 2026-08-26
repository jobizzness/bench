import type { PointerEvent as ReactPointerEvent } from "react";
import type { RosterRow } from "../../shared/types.js";
import { useBenchActions } from "./context.js";
import { isWaiting } from "../waiting.js";
import { Meta } from "./Meta.js";
import { GripMark } from "./GripMark.js";

/** One specialist in the roster: its name, its quiet line, and the two things
 * you can do to the row itself - move it, or close it. */
export function Row({ row, selected, held, onTake, onNudge }: {
  row: RosterRow;
  selected: boolean;
  /** True while this is the row in the air. */
  held: boolean;
  onTake: (event: ReactPointerEvent<HTMLElement>) => void;
  /** One place up (-1) or down (+1), from the keyboard. */
  onNudge: (by: number) => void;
}) {
  const { select, closeSpecialist } = useBenchActions();

  return (
    <li
      className="row"
      data-status={row.status}
      // Status is not the same question as "does this want me". A specialist
      // that answered and wrote no report is awaiting_decision too, and the
      // roster was colouring it green while its own group count said nothing
      // was waiting.
      data-waiting={isWaiting(row)}
      data-held={held}
      aria-selected={selected}
      onClick={() => select(row.id)}
    >
      <div className="label"><span className="label-name">{row.label}</span></div>
      {/* Everything that is not its name, in one quiet line. The rail already
          says what the status is, in colour, so the word is not repeated
          here. */}
      <Meta row={row} />
      {/* A real button, not a decorated handle: dragging is a pointer gesture
          and the arrows are the same move for a hand that never leaves the
          keyboard. */}
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
    </li>
  );
}
