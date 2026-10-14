/**
 * @vitest-environment jsdom
 * @vitest-environment-options { "url": "http://localhost/?token=t" }
 */
import { describe, it, expect, afterEach } from "vitest";
import { bootCockpit, row, type Cockpit } from "./helpers/cockpit.js";

/**
 * Putting the roster away, and bringing it back. The slide itself is a
 * stylesheet's hover rule - jsdom has no layout or `:hover` - so it was
 * checked by hand at a real window. This covers what a click and a reload
 * can: the toggle, the mark left behind, the memory, and that none of it
 * exists below the breakpoint.
 */

function setNarrow(narrow: boolean): void {
  (window as unknown as { matchMedia: (query: string) => MediaQueryList }).matchMedia = ((query: string) => ({
    matches: narrow,
    media: query,
    onchange: null,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent: () => false,
  })) as unknown as (query: string) => MediaQueryList;
}

const rows = [row({ id: "a", label: "ui-designer", project: "/var/www/bench" })];

const app = () => ui.$<HTMLElement>("#app")!;
const toggle = () => ui.$<HTMLButtonElement>("#roster-toggle");
const peek = () => ui.$<HTMLButtonElement>("#roster-peek");

let ui: Cockpit;
afterEach(() => {
  ui?.unmount();
  localStorage.clear();
  delete (window as { matchMedia?: unknown }).matchMedia;
});

describe("the roster, open", () => {
  it("is open by default, with no mark rail", async () => {
    ui = await bootCockpit({ rows });
    expect(app().dataset.roster).toBeUndefined();
    expect(peek()).toBeNull();
    expect(toggle()?.getAttribute("aria-pressed")).toBe("false");
  });
});

describe("the roster, tucked", () => {
  it("tucks away on the toggle, leaving the mark and dropping the drag handle", async () => {
    ui = await bootCockpit({ rows });
    await ui.click(toggle());
    expect(app().dataset.roster).toBe("tucked");
    expect(peek()?.querySelector(".mark-logo")).not.toBeNull();
    expect(ui.$("#roster-handle")).toBeNull();
    // Still in the DOM - it slides in over the stage rather than remounting.
    expect(ui.$("#roster-list")).not.toBeNull();
    expect(toggle()?.getAttribute("aria-pressed")).toBe("true");
  });

  it("is remembered across a reload", async () => {
    ui = await bootCockpit({ rows });
    await ui.click(toggle());
    expect(JSON.parse(localStorage.getItem("bench:roster-tucked")!)).toBe(true);

    ui.unmount();
    ui = await bootCockpit({ rows });
    expect(app().dataset.roster).toBe("tucked");
  });

  it("comes back for good on a click of the mark", async () => {
    localStorage.setItem("bench:roster-tucked", "true");
    ui = await bootCockpit({ rows });
    await ui.click(peek());
    expect(app().dataset.roster).toBeUndefined();
    expect(peek()).toBeNull();
    expect(JSON.parse(localStorage.getItem("bench:roster-tucked")!)).toBe(false);
  });

  it("comes back for good on the toggle, pressed from inside the slid-in roster", async () => {
    localStorage.setItem("bench:roster-tucked", "true");
    ui = await bootCockpit({ rows });
    await ui.click(toggle());
    expect(app().dataset.roster).toBeUndefined();
  });
});

describe("below the phone breakpoint", () => {
  it("has no toggle, and a remembered tuck is not applied - there is no second pane", async () => {
    setNarrow(true);
    localStorage.setItem("bench:roster-tucked", "true");
    ui = await bootCockpit({ rows });
    expect(toggle()).toBeNull();
    expect(peek()).toBeNull();
    expect(app().dataset.roster).toBeUndefined();
  });
});
