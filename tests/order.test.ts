/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach } from "vitest";
import { dropIndex, inOrder, moved, rememberOrder, savedOrder } from "../src/client/order.js";

/**
 * The arithmetic behind dragging a specialist up the roster.
 *
 * Kept away from the DOM on purpose: where a row lands is a question about a
 * list and a height, and it should be answerable without a browser.
 */

const rows = (...ids: string[]) => ids.map((id) => ({ id }));

describe("moving a row", () => {
  it("puts it where it was dropped", () => {
    expect(moved(["a", "b", "c"], 2, 0)).toEqual(["c", "a", "b"]);
    expect(moved(["a", "b", "c"], 0, 2)).toEqual(["b", "c", "a"]);
  });

  it("leaves the list alone when it is dropped where it started", () => {
    expect(moved(["a", "b", "c"], 1, 1)).toEqual(["a", "b", "c"]);
  });

  it("clamps a drop past either end rather than losing the row", () => {
    expect(moved(["a", "b", "c"], 0, 99)).toEqual(["b", "c", "a"]);
    expect(moved(["a", "b", "c"], 2, -5)).toEqual(["c", "a", "b"]);
  });
});

describe("where the pointer says to drop", () => {
  // Three rows of 40px, starting at 100 - what getBoundingClientRect would
  // have said when the drag began.
  const slots = [
    { top: 100, height: 40 },
    { top: 140, height: 40 },
    { top: 180, height: 40 },
  ];

  it("is the row the pointer is over", () => {
    expect(dropIndex(slots, 110)).toBe(0);
    expect(dropIndex(slots, 150)).toBe(1);
    expect(dropIndex(slots, 190)).toBe(2);
  });

  it("is the first row when the pointer is dragged above the list", () => {
    expect(dropIndex(slots, 10)).toBe(0);
  });

  it("is the last row when the pointer is dragged below it", () => {
    expect(dropIndex(slots, 9000)).toBe(2);
  });

  it("says nought for a list with nothing in it", () => {
    expect(dropIndex([], 40)).toBe(0);
  });
});

describe("drawing a group somebody has arranged", () => {
  it("draws it in the order they left it", () => {
    expect(inOrder(rows("a", "b", "c"), ["c", "a", "b"]).map((r) => r.id)).toEqual(["c", "a", "b"]);
  });

  it("ignores an id for a specialist that has since been closed", () => {
    expect(inOrder(rows("a", "b"), ["b", "gone", "a"]).map((r) => r.id)).toEqual(["b", "a"]);
  });

  it("puts a specialist started since then at the top, where it will be seen", () => {
    expect(inOrder(rows("a", "b", "new"), ["a", "b"]).map((r) => r.id)).toEqual(["new", "a", "b"]);
  });
});

describe("what the browser keeps", () => {
  beforeEach(() => { localStorage.clear(); });

  it("remembers an order per project, not one for the whole roster", () => {
    rememberOrder("/var/www/one", ["a", "b"]);
    rememberOrder("/var/www/two", ["c"]);

    expect(savedOrder()).toEqual({ "/var/www/one": ["a", "b"], "/var/www/two": ["c"] });
  });

  it("replaces a project's order rather than adding to it, so closed rows fall out", () => {
    rememberOrder("/var/www/one", ["a", "b", "c"]);
    rememberOrder("/var/www/one", ["b", "a"]);

    expect(savedOrder()["/var/www/one"]).toEqual(["b", "a"]);
  });

  it("shrugs off a stored value that is not an order at all", () => {
    localStorage.setItem("bench:roster-order", JSON.stringify(["a", "b"]));

    expect(savedOrder()).toEqual({});
  });

  it("starts empty, which is every group in the roster's own order", () => {
    expect(savedOrder()).toEqual({});
  });
});
