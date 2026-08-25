/**
 * @vitest-environment jsdom
 * @vitest-environment-options { "url": "http://localhost/?token=t" }
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { bootCockpit, row, type Cockpit } from "./helpers/cockpit.js";
import { setTheme } from "../src/client/theme.js";

/**
 * Picking a palette is the one setting that shows you its own effect. So what
 * is worth holding here is not that a value was stored - it is that the page
 * changed on the click, without a Save, and that it is still changed on the
 * next visit.
 */
const KEY = "bench:theme";

let ui: Cockpit;
afterEach(() => {
  ui?.unmount();
  // The store outlives one test, and the attribute it wrote outlives the tree.
  // Both are put back: a test that reloaded the module left the attribute
  // behind on an instance this one cannot reach.
  setTheme("bench");
  document.documentElement.dataset.theme = "bench";
  localStorage.clear();
  vi.restoreAllMocks();
  history.pushState({}, "", "/?token=t");
});

const rows = [row({ id: "a", label: "auth" })];
const openSettings = async () => { await ui.click(ui.$("#open-settings")); };
const chip = (id: string) => ui.$<HTMLButtonElement>(`.s-theme[data-theme="${id}"]`);
const applied = () => document.documentElement.dataset.theme;
const stored = () => JSON.parse(localStorage.getItem(KEY) ?? "null");

describe("the theme picker", () => {
  it("offers every theme, drawn in itself", async () => {
    ui = await bootCockpit({ rows });
    await openSettings();

    const names = ui.$$("#s-theme-list .s-theme-name").map((n) => n.textContent);
    expect(names).toEqual(["Bench", "Slate", "Ink", "Paper", "Contrast"]);

    // Each chip carries the theme it offers, which is what makes it a sample
    // of that palette rather than a description of one.
    expect(chip("paper")!.dataset.theme).toBe("paper");
  });

  it("starts on the theme the cockpit was designed in", async () => {
    ui = await bootCockpit({ rows });
    await openSettings();

    expect(applied()).toBe("bench");
    expect(chip("bench")!.getAttribute("aria-pressed")).toBe("true");
    expect(chip("paper")!.getAttribute("aria-pressed")).toBe("false");
  });

  it("repaints the whole cockpit on the click, not on Save", async () => {
    ui = await bootCockpit({ rows });
    await openSettings();

    await ui.click(chip("paper"));

    // One attribute on <html> is the whole of applying a theme: every rule in
    // the stylesheet reads its colour out of a variable that block fills in.
    expect(applied()).toBe("paper");
    expect(chip("paper")!.getAttribute("aria-pressed")).toBe("true");
    expect(chip("bench")!.getAttribute("aria-pressed")).toBe("false");

    // Nothing was saved, because nothing needed to be. The house rules on the
    // same sheet still belong to the daemon and still wait for Save.
    expect(ui.sent).toEqual([]);
  });

  it("says what you are looking at", async () => {
    ui = await bootCockpit({ rows });
    await openSettings();
    await ui.click(chip("contrast"));

    expect(ui.$("#s-theme-note")!.textContent).toContain("Built to be legible first");
  });

  it("is remembered by this browser", async () => {
    ui = await bootCockpit({ rows });
    await openSettings();
    await ui.click(chip("ink"));

    expect(stored()).toBe("ink");
  });

  it("does not send the choice to the daemon", async () => {
    ui = await bootCockpit({ rows });
    await openSettings();
    await ui.click(chip("slate"));
    await ui.click(ui.$("#s-save"));

    // A theme is a property of the screen in front of you. The phone reading
    // the same bench keeps its own, so saving must not carry it over.
    const settings = ui.sent.find((s) => s.url.includes("/api/settings"));
    expect(settings).toBeDefined();
    expect(JSON.stringify(settings!.body)).not.toContain("slate");
  });
});

describe("on the next visit", () => {
  it("opens in the theme the last one chose", async () => {
    localStorage.setItem(KEY, JSON.stringify("paper"));
    vi.resetModules();

    // A fresh import is the page loading: the store reads storage once, at
    // module scope, before anything renders.
    await import("../src/client/theme.js");

    expect(applied()).toBe("paper");
  });

  it("falls back rather than opening with no palette at all", async () => {
    // A theme that was removed, or a hand-edited key.
    localStorage.setItem(KEY, JSON.stringify("solarized"));
    vi.resetModules();

    const fresh = await import("../src/client/theme.js");

    expect(fresh.currentTheme()).toBe("bench");
    expect(applied()).toBe("bench");
  });

  it("survives storage being refused outright", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("denied"); });
    vi.resetModules();

    const fresh = await import("../src/client/theme.js");

    expect(fresh.currentTheme()).toBe("bench");
  });
});
