/**
 * Pure arithmetic behind the roster's draggable width (#145), split out for
 * the same reason `sheetGesture.ts` is: jsdom has no layout, so this is the
 * slice a unit test can actually exercise. `useRosterWidth.ts` and
 * `useRosterDrag.ts` wire it to the DOM and are checked by hand instead.
 */

/** 276px, the width this replaces, plus 50 - the ticket's own ask. */
export const DEFAULT_ROSTER_WIDTH = 326;

/** Narrower than this and the labels the roster carries stop fitting. */
export const MIN_ROSTER_WIDTH = 240;

/** Wider than this and the stage starts losing more room than the roster
 * gains - both as an absolute cap and as a share of a narrow window, so a
 * half-width browser does not lose its stage entirely to a resize. */
export const MAX_ROSTER_WIDTH = 560;
export const MAX_ROSTER_WIDTH_VIEWPORT_FRACTION = 0.45;

/** How far one press of an arrow key moves the divider. */
export const ROSTER_WIDTH_STEP = 16;

/** The upper bound in effect for a given viewport - the smaller of the flat
 * cap and the viewport-relative one. */
export function maxRosterWidth(viewportWidth: number): number {
  return Math.min(MAX_ROSTER_WIDTH, viewportWidth * MAX_ROSTER_WIDTH_VIEWPORT_FRACTION);
}

/** Clamps a candidate width - dragged, stepped, or recalled from a browser
 * that has since been resized - to what the current viewport allows. */
export function clampRosterWidth(width: number, viewportWidth: number): number {
  return Math.min(Math.max(width, MIN_ROSTER_WIDTH), maxRosterWidth(viewportWidth));
}
