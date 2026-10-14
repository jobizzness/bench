import { useCallback, useState } from "react";
import { recall, remember } from "../remembered.js";

const STORAGE_KEY = "roster-tucked";

export interface RosterTucked {
  /** Whether the developer has put the roster away - the stage takes the
   * room, and only the mark is left at the edge to bring it back. */
  tucked: boolean;
  toggle: () => void;
}

/**
 * Whether the roster is tucked away, in this browser - the same kind of
 * arrangement `useRosterWidth.ts` remembers, and kept beside it for the same
 * reason: it is how one person laid out their window, not anything the daemon
 * owns. Hovering the mark slides the roster back in over the stage without
 * changing this; only the toggle does.
 *
 * Read by `App.tsx` only above the phone breakpoint - below it there is no
 * second pane to put away.
 */
export function useRosterTucked(): RosterTucked {
  const [tucked, setTucked] = useState(() => recall<unknown>(STORAGE_KEY, false) === true);

  const toggle = useCallback(() => {
    setTucked((was) => {
      remember(STORAGE_KEY, !was);
      return !was;
    });
  }, []);

  return { tucked, toggle };
}
