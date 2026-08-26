import { useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { dropIndex, moved, type Slot } from "../order.js";

/** The row in the air: which one, and where it currently wants to land. */
interface Drag { id: string; to: number }

export interface RowOrder<T> {
  /** The rows as they should be drawn - with the held row already moved to
   * where it would land, so the list rearranges under the pointer rather than
   * only when it is let go. */
  rows: T[];
  /** The one being dragged, so it can be drawn as lifted. */
  held: string | null;
  /** Put on the grip. The index is the row's place in the list as drawn. */
  take: (event: ReactPointerEvent<HTMLElement>, index: number) => void;
  /** The same move, one place at a time, for a hand that is on the keyboard.
   * Committed immediately: there is no gesture in flight to let go of. */
  nudge: (index: number, by: number) => void;
}

/**
 * Dragging a row up or down its group.
 *
 * Pointer events rather than HTML5 drag-and-drop: the cockpit is installed on
 * phones, and dragstart never fires for a finger. The cost is that scrolling
 * and dragging have to be told apart, which is what the grip is for - it is
 * the only part of the row that takes the gesture, so everywhere else on it
 * still scrolls.
 *
 * The listeners are on the window, not the grip. A pointer that leaves the
 * roster mid-drag is still dragging, and a pointer released over the stage
 * still means "put it down".
 */
export function useRowOrder<T extends { id: string }>(
  rows: readonly T[],
  onDrop: (ids: string[]) => void,
): RowOrder<T> {
  const [drag, setDrag] = useState<Drag | null>(null);
  // Where the rows were when the gesture began. Measured once: the list moves
  // underneath the pointer, and measuring it again would be asking where the
  // rows are now rather than where the developer is pointing.
  const slots = useRef<Slot[]>([]);
  // Read by the window listeners, which are bound once per drag and would
  // otherwise close over the first render's rows.
  const latest = useRef<{ rows: readonly T[]; onDrop: (ids: string[]) => void }>({ rows, onDrop });
  latest.current = { rows, onDrop };

  const take = (event: ReactPointerEvent<HTMLElement>, index: number) => {
    // The grip sits inside a row that selects on click and inside a summary
    // that folds on one. Neither should happen because a drag started.
    event.preventDefault();
    event.stopPropagation();

    const list = event.currentTarget.closest("ul");
    slots.current = list
      ? [...list.children].map((el) => {
          const box = el.getBoundingClientRect();
          return { top: box.top, height: box.height };
        })
      : [];
    setDrag({ id: rows[index]?.id ?? "", to: index });
  };

  useEffect(() => {
    if (drag === null) return;

    const move = (event: PointerEvent) => {
      const to = dropIndex(slots.current, event.clientY);
      setDrag((held) => (held === null || held.to === to ? held : { ...held, to }));
    };
    const drop = () => {
      setDrag((held) => {
        if (held !== null) latest.current.onDrop(arrange(latest.current.rows, held).map((r) => r.id));
        return null;
      });
    };
    // Let go of it without moving it. A gesture that cannot be abandoned is
    // one you have to finish correctly, and this one is done by hand.
    const abandon = (event: KeyboardEvent) => { if (event.key === "Escape") setDrag(null); };
    // A cancelled pointer is the browser taking the gesture back - a scroll it
    // decided was a scroll, or a call arriving. Nothing was decided, so
    // nothing is saved.
    const give = () => setDrag(null);

    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", drop);
    window.addEventListener("pointercancel", give);
    window.addEventListener("keydown", abandon);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", drop);
      window.removeEventListener("pointercancel", give);
      window.removeEventListener("keydown", abandon);
    };
  }, [drag !== null]);

  const nudge = (index: number, by: number) => {
    const to = index + by;
    if (to < 0 || to >= rows.length) return;
    onDrop(moved(rows, index, to).map((row) => row.id));
  };

  return {
    rows: drag === null ? [...rows] : arrange(rows, drag),
    held: drag?.id ?? null,
    take,
    nudge,
  };
}

/** The list as it stands mid-drag. The held row is found by id rather than by
 * the index it started at: the daemon may have pushed a new roster while a
 * finger was down, and the arrangement should follow the row, not the slot. */
function arrange<T extends { id: string }>(rows: readonly T[], drag: Drag): T[] {
  return moved(rows, rows.findIndex((row) => row.id === drag.id), drag.to);
}
