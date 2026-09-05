/**
 * @vitest-environment jsdom
 */
import { describe, it, expect } from "vitest";
import { isOutsideDialog, pastDismissThreshold, findScrollableAncestor, DISMISS_DISTANCE, DISMISS_VELOCITY } from "../src/client/components/sheetGesture.js";

/**
 * The scrim-tap and swipe-threshold arithmetic behind #91's dismiss
 * gestures. jsdom has no layout, no compositor and no touch, so the hook
 * itself - `useSheetDismissGestures` - is checked at a real phone viewport
 * over CDP instead (see the report on #91). This is the slice that is pure
 * geometry and can be held here.
 */
describe("isOutsideDialog", () => {
  const rect = { left: 10, top: 20, right: 110, bottom: 220 };

  it("is inside for a click within the dialog's own box", () => {
    expect(isOutsideDialog(50, 50, rect)).toBe(false);
    // On the boundary counts as inside, not outside.
    expect(isOutsideDialog(10, 20, rect)).toBe(false);
    expect(isOutsideDialog(110, 220, rect)).toBe(false);
  });

  it("is outside for a click beyond any edge", () => {
    expect(isOutsideDialog(5, 50, rect)).toBe(true);
    expect(isOutsideDialog(150, 50, rect)).toBe(true);
    expect(isOutsideDialog(50, 5, rect)).toBe(true);
    expect(isOutsideDialog(50, 300, rect)).toBe(true);
  });
});

describe("pastDismissThreshold", () => {
  it("springs back short of both the distance and the velocity", () => {
    expect(pastDismissThreshold(DISMISS_DISTANCE - 1, DISMISS_VELOCITY - 0.1)).toBe(false);
  });

  it("dismisses on distance alone, a slow drag that goes far enough", () => {
    expect(pastDismissThreshold(DISMISS_DISTANCE, 0.01)).toBe(true);
  });

  it("dismisses on velocity alone, a flick that never travelled far", () => {
    expect(pastDismissThreshold(20, DISMISS_VELOCITY)).toBe(true);
  });
});

describe("findScrollableAncestor", () => {
  function scrollable(scrollHeight: number, clientHeight: number, overflowY = "auto"): HTMLElement {
    const el = document.createElement("div");
    Object.defineProperty(el, "scrollHeight", { value: scrollHeight, configurable: true });
    Object.defineProperty(el, "clientHeight", { value: clientHeight, configurable: true });
    el.style.overflowY = overflowY;
    return el;
  }

  it("finds a scrollable ancestor closer than the root", () => {
    const root = scrollable(100, 100); // nothing to scroll at the root itself
    const inner = scrollable(400, 100); // this one does
    const leaf = document.createElement("span");
    inner.appendChild(leaf);
    root.appendChild(inner);
    expect(findScrollableAncestor(leaf, root)).toBe(inner);
  });

  it("falls back to the root when nothing closer qualifies", () => {
    const root = scrollable(400, 100); // the root is the one with something to scroll
    const inner = scrollable(100, 100); // this one has nothing to scroll
    const leaf = document.createElement("span");
    inner.appendChild(leaf);
    root.appendChild(inner);
    expect(findScrollableAncestor(leaf, root)).toBe(root);
  });

  it("never looks past the root", () => {
    const outer = scrollable(400, 100); // scrollable, but outside the root - must not be picked
    const root = scrollable(100, 100);
    const leaf = document.createElement("span");
    root.appendChild(leaf);
    outer.appendChild(root);
    expect(findScrollableAncestor(leaf, root)).toBe(root);
  });
});
