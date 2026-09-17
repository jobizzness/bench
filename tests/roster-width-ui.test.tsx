/**
 * @vitest-environment jsdom
 * @vitest-environment-options { "url": "http://localhost/?token=t" }
 */
import { describe, it, expect, afterEach } from "vitest";
import { bootCockpit, row, type Cockpit } from "./helpers/cockpit.js";

/**
 * The roster's draggable width (#145), everything short of an actual drag -
 * jsdom has no layout or pointer capture, so the pointer wiring itself
 * (`useRosterDrag.ts`) is checked by hand at a real window instead (see the
 * report on this issue). This covers what a mount, a reload and a keypress
 * can exercise: the default, the remembered round trip, the keyboard path,
 * the double-click reset, and that none of it exists below the breakpoint.
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

const rosterWidthProperty = () => document.documentElement.style.getPropertyValue("--roster-width");
const handle = () => ui.$<HTMLDivElement>("#roster-handle");

let ui: Cockpit;
afterEach(() => {
  ui?.unmount();
  localStorage.clear();
  document.documentElement.style.removeProperty("--roster-width");
  delete (window as { matchMedia?: unknown }).matchMedia;
});

describe("the roster width, nothing remembered", () => {
  it("is 326px - the current 276px plus 50", async () => {
    ui = await bootCockpit({ rows });
    expect(rosterWidthProperty()).toBe("326px");
    expect(handle()?.getAttribute("aria-valuenow")).toBe("326");
  });
});

describe("the roster width, remembered", () => {
  it("is restored on the next mount, clamped to what the window allows", async () => {
    localStorage.setItem("bench:roster-width", JSON.stringify(400));
    ui = await bootCockpit({ rows });
    expect(rosterWidthProperty()).toBe("400px");
  });

  it("falls back to the default when storage is empty", async () => {
    ui = await bootCockpit({ rows });
    expect(rosterWidthProperty()).toBe("326px");
  });

  it("falls back to the default when storage holds nonsense", async () => {
    localStorage.setItem("bench:roster-width", "{not json");
    ui = await bootCockpit({ rows });
    expect(rosterWidthProperty()).toBe("326px");
  });

  it("falls back to the default when storage holds something that parses but isn't a width", async () => {
    localStorage.setItem("bench:roster-width", JSON.stringify("wide, please"));
    ui = await bootCockpit({ rows });
    expect(rosterWidthProperty()).toBe("326px");
  });
});

describe("the handle", () => {
  it("is reachable without a mouse and describes itself as a vertical separator", async () => {
    ui = await bootCockpit({ rows });
    const el = handle();
    expect(el?.getAttribute("role")).toBe("separator");
    expect(el?.getAttribute("aria-orientation")).toBe("vertical");
    expect(el?.tabIndex).toBe(0);
  });

  it("moves in steps on Left and Right, and remembers where it lands", async () => {
    ui = await bootCockpit({ rows });
    const el = handle()!;
    await ui.pressIn(el, "ArrowRight");
    const afterOne = Number(rosterWidthProperty().replace("px", ""));
    expect(afterOne).toBeGreaterThan(326);
    expect(JSON.parse(localStorage.getItem("bench:roster-width")!)).toBe(afterOne);

    await ui.pressIn(el, "ArrowLeft");
    await ui.pressIn(el, "ArrowLeft");
    const afterThree = Number(rosterWidthProperty().replace("px", ""));
    expect(afterThree).toBeLessThan(326);
  });

  it("double-click returns the roster to 326px and forgets the remembered value", async () => {
    localStorage.setItem("bench:roster-width", JSON.stringify(450));
    ui = await bootCockpit({ rows });
    expect(rosterWidthProperty()).toBe("450px");

    await ui.run(() => { handle()!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })); });

    expect(rosterWidthProperty()).toBe("326px");
    expect(localStorage.getItem("bench:roster-width")).toBeNull();

    ui.unmount();
    ui = await bootCockpit({ rows });
    expect(rosterWidthProperty()).toBe("326px");
  });
});

describe("below the phone breakpoint", () => {
  it("mounts no handle and applies no custom property", async () => {
    setNarrow(true);
    ui = await bootCockpit({ rows });
    expect(handle()).toBeNull();
    expect(rosterWidthProperty()).toBe("");
  });
});
