import { useCallback, useLayoutEffect, useState } from "react";
import { forget, recall, remember } from "../remembered.js";
import { clampRosterWidth, DEFAULT_ROSTER_WIDTH } from "./rosterWidth.js";
import { useNarrowViewport } from "./useNarrowViewport.js";

const STORAGE_KEY = "roster-width";

function liveViewportWidth(): number {
  return typeof window === "undefined" ? Number.POSITIVE_INFINITY : window.innerWidth;
}

/** The developer's own preference, clamped only to the two flat bounds - not
 * to a viewport, which is `clampRosterWidth`'s other job. Passing `Infinity`
 * as the viewport width makes the viewport-relative cap in `maxRosterWidth`
 * moot without a second clamp to keep in step with the first (#145). */
function ownPreference(width: number): number {
  return clampRosterWidth(width, Number.POSITIVE_INFINITY);
}

function storedWidth(): number {
  const value = recall<unknown>(STORAGE_KEY, DEFAULT_ROSTER_WIDTH);
  return typeof value === "number" && Number.isFinite(value) ? value : DEFAULT_ROSTER_WIDTH;
}

export interface RosterWidth {
  /** Whether the viewport is below the phone breakpoint - where there is no
   * second pane, so nothing here applies. */
  narrow: boolean;
  width: number;
  setWidth: (width: number) => void;
  /** Back to 326px, and the stored preference is forgotten rather than
   * overwritten with the default (see `forget` in `remembered.ts`). */
  reset: () => void;
}

/**
 * Owns the roster's width: what this browser last left it at, and what the
 * current window actually has room for - two different things, kept as two
 * different pieces of state. `chosen` is the developer's preference, touched
 * only by a drag, an arrow key or a reset; `width`, what is actually
 * rendered, is `chosen` clamped against the *live* viewport width on every
 * render. A window narrowed past `chosen` therefore only ever constrains the
 * display - `chosen` (and the storage it is mirrored to) never changes on a
 * resize, so growing the window back recovers the original width without
 * needing a reload. An earlier version of this hook clamped `chosen` itself
 * on resize, which meant a shrink-then-grow could not recover it at all -
 * only a reload (re-reading storage from scratch) could.
 *
 * `width` is mirrored onto `--roster-width` on the root element -
 * `styles.css` reads that custom property with the same 326px fallback as
 * its own literal default, the same split `useVisualViewportHeight.ts` uses,
 * so the stylesheet still stands alone.
 *
 * `useLayoutEffect`, not `useEffect`: the property has to land before the
 * browser paints, or a remembered width flashes the CSS default first.
 *
 * Inert below the phone breakpoint - no property is set, and it is removed
 * if one is already there from a resize down across it - because below it
 * `#app`'s grid (and the roster width with it) does not exist at all.
 */
export function useRosterWidth(): RosterWidth {
  const narrow = useNarrowViewport();
  const [chosen, setChosen] = useState(() => ownPreference(storedWidth()));
  const [viewport, setViewport] = useState(liveViewportWidth);

  const width = clampRosterWidth(chosen, viewport);

  useLayoutEffect(() => {
    if (narrow) {
      document.documentElement.style.removeProperty("--roster-width");
      return;
    }
    document.documentElement.style.setProperty("--roster-width", `${width}px`);
    return () => { document.documentElement.style.removeProperty("--roster-width"); };
  }, [width, narrow]);

  useLayoutEffect(() => {
    if (narrow) return;
    // Resynced on every entry above the breakpoint, not just read once at
    // mount - a window that changed size while this was inert (narrow, or
    // not yet mounted) would otherwise render one stale frame off it.
    setViewport(window.innerWidth);
    const onResize = () => setViewport(window.innerWidth);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [narrow]);

  const setWidth = useCallback((next: number) => {
    setChosen(() => {
      const clamped = ownPreference(next);
      remember(STORAGE_KEY, clamped);
      return clamped;
    });
  }, []);

  const reset = useCallback(() => {
    forget(STORAGE_KEY);
    setChosen(ownPreference(DEFAULT_ROSTER_WIDTH));
  }, []);

  return { narrow, width, setWidth, reset };
}
