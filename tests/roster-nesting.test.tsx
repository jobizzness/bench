/**
 * @vitest-environment jsdom
 * @vitest-environment-options { "url": "http://localhost/?token=t" }
 */
import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { bootCockpit, row, type Cockpit } from "./helpers/cockpit.js";

/**
 * A tab another specialist opened with `bench new` is drawn under it, not
 * loose in the group - so the roster tells you whose work a sub-agent is
 * doing before you have opened either tab.
 */

let ui: Cockpit;
beforeEach(() => { localStorage.clear(); });
afterEach(() => { ui?.unmount(); });

const labelsOf = (nodes: HTMLElement[]) =>
  nodes.map((el) => el.querySelector(".label-name")!.textContent);

/** The row itself, one level inside the <li> that also holds its children -
 * see Row.tsx for why the two are siblings rather than parent and child. */
const rootRow = (ui: Cockpit) => ui.$$(".group-rows > li > .row");
const nestedRow = (ui: Cockpit) => ui.$$(".sub-rows > li > .row");

describe("a tab another specialist opened", () => {
  it("is drawn nested under it, not as a row of its own in the group", async () => {
    ui = await bootCockpit({
      rows: [
        row({ id: "parent", label: "auth" }),
        row({ id: "child", label: "auth-tests", createdBy: "parent" }),
      ],
    });

    // Directly under the group, only the specialist nobody opened.
    expect(labelsOf(rootRow(ui))).toEqual(["auth"]);
    // Under that row, the one it opened.
    expect(labelsOf(nestedRow(ui))).toEqual(["auth-tests"]);
  });

  it("nests as many levels deep as the chain of delegation runs", async () => {
    ui = await bootCockpit({
      rows: [
        row({ id: "a", label: "root" }),
        row({ id: "b", label: "mid", createdBy: "a" }),
        row({ id: "c", label: "leaf", createdBy: "b" }),
      ],
    });

    const mid = nestedRow(ui)[0];
    expect(mid.querySelector(".label-name")!.textContent).toBe("mid");
    // The leaf is inside a second, deeper .sub-rows - a sibling of mid's own
    // row content, not something mid's row itself contains. Scoped to mid's
    // *own* sub-rows (a direct child of its <li>) rather than searched with
    // `.sub-rows li .row`, which - evaluated against the whole document,
    // the way querySelector resolves combinators - would also match mid
    // itself, since mid sits under root's .sub-rows too.
    const midSubRows = mid.closest("li")!.querySelector(":scope > .sub-rows")!;
    const leaf = midSubRows.querySelector("li > .row");
    expect(leaf?.querySelector(".label-name")!.textContent).toBe("leaf");
  });

  it("marks a nested row so it can be styled and skips it in the drag order", async () => {
    ui = await bootCockpit({
      rows: [
        row({ id: "parent", label: "auth" }),
        row({ id: "child", label: "auth-tests", createdBy: "parent" }),
      ],
    });

    const child = nestedRow(ui)[0];
    expect(child.dataset.nested).toBe("true");
    // Nothing to drag it by: reordering a tree nobody asked to reorder is
    // not a gesture this row offers.
    expect(child.querySelector(".grip")).toBeNull();
  });

  it("surfaces at the top level when whoever opened it is gone", async () => {
    // createdBy points at an id restored some other way, or since closed.
    // Nobody to nest under, so it is not lost.
    ui = await bootCockpit({
      rows: [row({ id: "orphan", label: "orphan", createdBy: "sess-long-gone" })],
    });

    expect(labelsOf(rootRow(ui))).toEqual(["orphan"]);
  });

  it("still counts a nested row in the group's waiting total", async () => {
    ui = await bootCockpit({
      rows: [
        row({ id: "parent", label: "auth" }),
        row({
          id: "child", label: "auth-tests", createdBy: "parent",
          status: "awaiting_decision", latestReportSeq: 3, answeredReportSeq: null,
        }),
      ],
    });

    expect(ui.$(".group .count")?.textContent).toBe("1 waiting");
  });

  it("lights the spine under a branch that wants you", async () => {
    ui = await bootCockpit({
      rows: [
        row({ id: "parent", label: "auth" }),
        row({
          id: "child", label: "auth-tests", createdBy: "parent",
          status: "awaiting_decision", latestReportSeq: 3, answeredReportSeq: null,
        }),
      ],
    });

    expect(ui.$(".sub-rows")?.getAttribute("data-waiting")).toBe("true");
  });

  it("does not put a nested row's close button inside its parent's box", async () => {
    // A row that contained its children in the DOM would put every
    // grandchild's close button inside its own hover scope (`.row:hover
    // .close` is a descendant selector) - hovering "auth" would then reveal
    // close buttons on every specialist under it, anywhere in the tree.
    ui = await bootCockpit({
      rows: [
        row({ id: "parent", label: "auth" }),
        row({ id: "child", label: "auth-tests", createdBy: "parent" }),
      ],
    });

    const parent = rootRow(ui)[0];
    const childClose = nestedRow(ui)[0].querySelector(".close");
    expect(parent.contains(childClose)).toBe(false);
  });

  it("selects the row actually clicked, not an ancestor it happens to sit under", async () => {
    // Rows and their children are siblings, not parent and descendant - see
    // Row.tsx. If they were nested, a click on the child would bubble
    // through the parent's onClick and select the parent instead.
    ui = await bootCockpit({
      rows: [
        row({ id: "parent", label: "auth" }),
        row({ id: "child", label: "auth-tests", createdBy: "parent" }),
      ],
    });

    await ui.click(nestedRow(ui)[0]);

    const selected = ui.$$(".row").find((el) => el.getAttribute("aria-selected") === "true");
    expect(selected?.querySelector(".label-name")!.textContent).toBe("auth-tests");
  });
});
