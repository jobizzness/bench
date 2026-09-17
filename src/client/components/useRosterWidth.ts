import { useCallback, useLayoutEffect, useState } from "react";
import { forget, recall, remember } from "../remembered.js";
import { clampRosterWidth, DEFAULT_ROSTER_WIDTH } from "./rosterWidth.js";
import { useNarrowViewport } from "./useNarrowViewport.js";

const STORAGE_KEY = "roster-width";

function viewportWidth(): number {
  return typeof window === "undefined" ? DEFAULT_ROSTER_WIDTH : window.innerWidth;
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
 * Owns the roster's width: what this browser last left it at, clamped to
 * whatever the window currently allows, and mirrored onto `--roster-width`
 * on the root element - `styles.css` reads that custom property with the
 * same 326px fallback as its own literal default, the same split
 * `useVisualViewportHeight.ts` uses, so the stylesheet still stands alone.
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
  const [width, setWidthState] = useState(() => clampRosterWidth(storedWidth(), viewportWidth()));

  useLayoutEffect(() => {
    if (narrow) {
      document.documentElement.style.removeProperty("--roster-width");
      return;
    }
    document.documentElement.style.setProperty("--roster-width", `${width}px`);
    return () => { document.documentElement.style.removeProperty("--roster-width"); };
  }, [width, narrow]);

  // A window narrowed after the fact can put an already-chosen width out of
  // range (the clamp's own last case) - re-clamped against the live width
  // rather than the remembered one, and not written back to storage: a
  // preference should survive the window growing again, not be trimmed down
  // permanently by a transient resize.
  useLayoutEffect(() => {
    if (narrow) return;
    const onResize = () => setWidthState((current) => clampRosterWidth(current, window.innerWidth));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [narrow]);

  const setWidth = useCallback((next: number) => {
    setWidthState(() => {
      const clamped = clampRosterWidth(next, viewportWidth());
      remember(STORAGE_KEY, clamped);
      return clamped;
    });
  }, []);

  const reset = useCallback(() => {
    forget(STORAGE_KEY);
    setWidthState(DEFAULT_ROSTER_WIDTH);
  }, []);

  return { narrow, width, setWidth, reset };
}
