/**
 * @vitest-environment jsdom
 * @vitest-environment-options { "url": "http://localhost/?token=t" }
 */
import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { bootCockpit, row, type Cockpit } from "./helpers/cockpit.js";

/**
 * Dragging a specialist up the roster.
 *
 * The arithmetic is tested next door in order.test.ts. What is held here is
 * the wiring: that a gesture on the grip moves the row it belongs to, that
 * the browser remembers where it was put, and that a group nobody has touched
 * still puts whoever is waiting first.
 */

const PROJECT = "/var/www/demo";
const ORDER = "bench:roster-order";

const three = [
  row({ id: "s1", label: "auth", status: "working" }),
  row({ id: "s2", label: "billing", status: "working" }),
  row({ id: "s3", label: "search", status: "working" }),
];

let ui: Cockpit;
beforeEach(() => { localStorage.clear(); });
afterEach(() => { ui?.unmount(); });

/** The labels down the roster, top to bottom. */
const drawn = () => ui.$$(".row").map((el) => el.querySelector(".label-name")!.textContent);

const rowNamed = (label: string) =>
  ui.$$(".row").find((el) => el.querySelector(".label-name")!.textContent === label)!;

const saved = () => JSON.parse(localStorage.getItem(ORDER) ?? "{}");

/**
 * A pointer taking hold of a row's grip and putting it down somewhere else.
 *
 * jsdom measures everything as nothing, so the rows are given the heights
 * they would have in a browser first: 40px each from y=100. `to` is the
 * height the pointer is let go at, which is a row on that scale.
 */
async function drag(label: string, to: number): Promise<void> {
  await ui.run(() => {
    ui.$$(".row").forEach((el, i) => {
      el.getBoundingClientRect = () => ({ top: 100 + i * 40, height: 40 }) as DOMRect;
    });
  });

  const grip = rowNamed(label).querySelector(".grip")!;
  await ui.run(() => { grip.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true })); });
  await ui.run(() => { window.dispatchEvent(new MouseEvent("pointermove", { clientY: to })); });
  await ui.run(() => { window.dispatchEvent(new MouseEvent("pointerup", {})); });
}

describe("a group nobody has arranged", () => {
  it("still puts whoever is waiting on you first", async () => {
    ui = await bootCockpit({
      rows: [
        row({ id: "s1", label: "auth", status: "working" }),
        row({ id: "s2", label: "billing", status: "awaiting_decision", latestReportSeq: 3 }),
      ],
    });

    expect(drawn()).toEqual(["billing", "auth"]);
  });

  it("has nothing written down for it", async () => {
    ui = await bootCockpit({ rows: three });

    expect(saved()).toEqual({});
  });
});

describe("dragging a row", () => {
  it("puts it where it was dropped", async () => {
    ui = await bootCockpit({ rows: three });

    await drag("search", 110);

    expect(drawn()).toEqual(["search", "auth", "billing"]);
  });

  it("writes the whole group down, in the browser", async () => {
    ui = await bootCockpit({ rows: three });

    await drag("search", 110);

    expect(saved()).toEqual({ [PROJECT]: ["s3", "s1", "s2"] });
  });

  it("is still in that order when the cockpit is opened again", async () => {
    ui = await bootCockpit({ rows: three });
    await drag("search", 110);
    ui.unmount();

    ui = await bootCockpit({ rows: three });

    expect(drawn()).toEqual(["search", "auth", "billing"]);
  });

  it("moves the row down as well as up", async () => {
    ui = await bootCockpit({ rows: three });

    await drag("auth", 190);

    expect(drawn()).toEqual(["billing", "search", "auth"]);
  });

  it("leaves the arrangement alone when the drag is abandoned", async () => {
    ui = await bootCockpit({ rows: three });
    await ui.run(() => {
      ui.$$(".row").forEach((el, i) => {
        el.getBoundingClientRect = () => ({ top: 100 + i * 40, height: 40 }) as DOMRect;
      });
    });
    const grip = rowNamed("search").querySelector(".grip")!;

    await ui.run(() => { grip.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true })); });
    await ui.run(() => { window.dispatchEvent(new MouseEvent("pointermove", { clientY: 110 })); });
    await ui.press("Escape");
    await ui.run(() => { window.dispatchEvent(new MouseEvent("pointerup", {})); });

    expect(drawn()).toEqual(["auth", "billing", "search"]);
    expect(saved()).toEqual({});
  });

  it("does not open the specialist it took hold of", async () => {
    ui = await bootCockpit({ rows: three });
    await ui.open("auth");

    await ui.click(rowNamed("search").querySelector(".grip"));

    expect(ui.$(".row[aria-selected='true']")!.textContent).toContain("auth");
  });
});

describe("a group that has been arranged", () => {
  it("stops rearranging itself around who is waiting", async () => {
    localStorage.setItem(ORDER, JSON.stringify({ [PROJECT]: ["s1", "s2"] }));

    ui = await bootCockpit({
      rows: [
        row({ id: "s1", label: "auth", status: "working" }),
        row({ id: "s2", label: "billing", status: "awaiting_decision", latestReportSeq: 3 }),
      ],
    });

    expect(drawn()).toEqual(["auth", "billing"]);
  });

  it("puts a specialist started since then at the top, not the bottom", async () => {
    localStorage.setItem(ORDER, JSON.stringify({ [PROJECT]: ["s1", "s2"] }));
    ui = await bootCockpit({ rows: three.slice(0, 2) });

    await ui.roster([...three.slice(0, 2), row({ id: "s9", label: "docs", status: "working" })]);

    expect(drawn()).toEqual(["docs", "auth", "billing"]);
  });

  it("keeps its own arrangement, not the other project's", async () => {
    localStorage.setItem(ORDER, JSON.stringify({ [PROJECT]: ["s2", "s1"] }));

    ui = await bootCockpit({
      rows: [
        ...three.slice(0, 2),
        row({ id: "o1", label: "infra", status: "working", project: "/var/www/other" }),
        row({ id: "o2", label: "deploy", status: "working", project: "/var/www/other" }),
      ],
    });

    expect(drawn()).toEqual(["billing", "auth", "infra", "deploy"]);
  });
});

describe("the grip on the keyboard", () => {
  it("moves the row up one place", async () => {
    ui = await bootCockpit({ rows: three });

    await ui.pressIn(rowNamed("billing").querySelector(".grip"), "ArrowUp");

    expect(drawn()).toEqual(["billing", "auth", "search"]);
    expect(saved()).toEqual({ [PROJECT]: ["s2", "s1", "s3"] });
  });

  it("moves it down one place", async () => {
    ui = await bootCockpit({ rows: three });

    await ui.pressIn(rowNamed("billing").querySelector(".grip"), "ArrowDown");

    expect(drawn()).toEqual(["auth", "search", "billing"]);
  });

  it("does nothing at the top of the list", async () => {
    ui = await bootCockpit({ rows: three });

    await ui.pressIn(rowNamed("auth").querySelector(".grip"), "ArrowUp");

    expect(drawn()).toEqual(["auth", "billing", "search"]);
    expect(saved()).toEqual({});
  });
});
