import { useRef } from "react";
import { ROSTER_WIDTH_STEP } from "./rosterWidth.js";
import { useRosterDrag } from "./useRosterDrag.js";

export interface RosterHandleProps {
  width: number;
  setWidth: (width: number) => void;
  reset: () => void;
}

/**
 * The divider between the roster and the stage (#145) - sits on `#roster`'s
 * own `border-right` (see `styles.css`) rather than adding a second line
 * beside it. Only ever mounted above the phone breakpoint: `App.tsx` does
 * not render this at all below it, which is what keeps the property this
 * drives (`--roster-width`, set by `useRosterWidth.ts`) from ever applying
 * where there is no second pane to divide.
 *
 * Dragging is wired by `useRosterDrag`; the two keyboard and double-click
 * paths are small enough to stay inline here rather than pulling in a third
 * module for them.
 */
export function RosterHandle({ width, setWidth, reset }: RosterHandleProps) {
  const handleRef = useRef<HTMLDivElement | null>(null);
  useRosterDrag(handleRef, width, setWidth);

  return (
    <div
      ref={handleRef}
      id="roster-handle"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize the roster"
      aria-valuenow={Math.round(width)}
      tabIndex={0}
      onKeyDown={(event) => {
        if (event.key === "ArrowLeft") {
          event.preventDefault();
          setWidth(width - ROSTER_WIDTH_STEP);
        } else if (event.key === "ArrowRight") {
          event.preventDefault();
          setWidth(width + ROSTER_WIDTH_STEP);
        }
      }}
      onDoubleClick={reset}
    />
  );
}
