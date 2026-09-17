import { describe, it, expect } from "vitest";
import {
  clampRosterWidth, maxRosterWidth,
  DEFAULT_ROSTER_WIDTH, MIN_ROSTER_WIDTH, MAX_ROSTER_WIDTH, MAX_ROSTER_WIDTH_VIEWPORT_FRACTION,
} from "../src/client/components/rosterWidth.js";

/**
 * The clamping behind the roster's draggable width (#145). Pure, so this is
 * the slice jsdom's lack of layout does not get in the way of - the pointer
 * and keyboard wiring (`useRosterDrag.ts`, `RosterHandle.tsx`) is checked by
 * hand at a real window instead.
 */
describe("clampRosterWidth", () => {
  const wideViewport = 1600; // 45vw = 720, so the flat 560px cap is what bites here.

  it("leaves a width already inside the range alone", () => {
    expect(clampRosterWidth(DEFAULT_ROSTER_WIDTH, wideViewport)).toBe(DEFAULT_ROSTER_WIDTH);
  });

  it("floors a width below the minimum", () => {
    expect(clampRosterWidth(0, wideViewport)).toBe(MIN_ROSTER_WIDTH);
    expect(clampRosterWidth(-50, wideViewport)).toBe(MIN_ROSTER_WIDTH);
    expect(clampRosterWidth(MIN_ROSTER_WIDTH - 1, wideViewport)).toBe(MIN_ROSTER_WIDTH);
  });

  it("caps a width above the flat maximum, on a viewport wide enough that the flat cap is what applies", () => {
    expect(clampRosterWidth(9999, wideViewport)).toBe(MAX_ROSTER_WIDTH);
  });

  it("caps a width above the viewport-relative maximum, on a viewport narrow enough that it undercuts the flat cap", () => {
    const narrowerViewport = 1000; // 45vw = 450, below the 560px flat cap.
    expect(clampRosterWidth(9999, narrowerViewport)).toBe(450);
    expect(maxRosterWidth(narrowerViewport)).toBe(narrowerViewport * MAX_ROSTER_WIDTH_VIEWPORT_FRACTION);
  });

  it("re-clamps a remembered width that is now out of range because the window shrank", () => {
    // 400px was a fine, remembered choice at 1600px wide (45vw = 720). The
    // same window narrowed to 800px brings 45vw down to 360.
    const remembered = 400;
    expect(clampRosterWidth(remembered, wideViewport)).toBe(remembered);
    expect(clampRosterWidth(remembered, 800)).toBe(360);
  });
});
