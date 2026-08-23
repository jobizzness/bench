/**
 * @vitest-environment jsdom
 * @vitest-environment-options { "url": "http://localhost/?token=t" }
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { bootCockpit, row, type Cockpit } from "./helpers/cockpit.js";
import { recall, remember } from "../src/client/remembered.js";

/**
 * How one person has arranged the view in front of them belongs to the
 * browser they arranged it in. Folding a project away and finding it open
 * again after a refresh is the cockpit forgetting something it was told.
 */

let ui: Cockpit;
afterEach(() => {
  ui?.unmount();
  localStorage.clear();
  vi.restoreAllMocks();
  history.pushState({}, "", "/?token=t");
});

const rows = [
  row({ id: "a", label: "ui-designer", project: "/var/www/bench" }),
  row({ id: "b", label: "payouts", project: "/var/www/teledoctor" }),
];

const groups = () => ui.$$("details.group");
const openState = () => groups().map((g) => (g as HTMLDetailsElement).open);

/** jsdom does not act on `open`, so folding is done the way a click would. */
async function fold(index: number): Promise<void> {
  const group = groups()[index] as HTMLDetailsElement;
  await ui.run(() => {
    group.open = false;
    group.dispatchEvent(new Event("toggle"));
  });
}

describe("what the browser remembers", () => {
  it("keeps a folded project folded across a reload", async () => {
    ui = await bootCockpit({ rows });
    await fold(1);
    expect(openState()).toEqual([true, false]);

    // A reload is a fresh mount against the same storage.
    ui.unmount();
    ui = await bootCockpit({ rows });

    expect(openState()).toEqual([true, false]);
  });

  it("forgets it again when it is opened back up", async () => {
    ui = await bootCockpit({ rows });
    await fold(1);

    const group = groups()[1] as HTMLDetailsElement;
    await ui.run(() => { group.open = true; group.dispatchEvent(new Event("toggle")); });

    ui.unmount();
    ui = await bootCockpit({ rows });
    expect(openState()).toEqual([true, true]);
  });

  it("starts with everything open, as it always did", async () => {
    ui = await bootCockpit({ rows });
    expect(openState()).toEqual([true, true]);
  });

  it("opens the cockpit anyway when the browser refuses to store anything", async () => {
    // Storage is disabled outright in some browsers and throws on write in
    // others. Neither is worth a cockpit that will not render.
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });

    ui = await bootCockpit({ rows });
    await fold(1);

    expect(openState()).toEqual([true, false]);
  });
});

describe("the store itself", () => {
  it("gives back what was put in", () => {
    remember("thing", { a: 1 });
    expect(recall("thing", null)).toEqual({ a: 1 });
  });

  it("falls back rather than throwing on something that is not JSON", () => {
    // A hand, or an older version of this, could have left anything there.
    localStorage.setItem("bench:thing", "{not json");
    expect(recall("thing", "fallback")).toBe("fallback");
  });

  it("keeps its keys to itself", () => {
    remember("thing", 1);
    expect(localStorage.getItem("bench:thing")).toBe("1");
  });
});
