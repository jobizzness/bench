/**
 * @vitest-environment jsdom
 * @vitest-environment-options { "url": "http://localhost/?token=t" }
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { bootCockpit, row, type Cockpit, type Fixtures } from "./helpers/cockpit.js";
import { waitFor } from "./helpers/wait-for.js";

/**
 * A glance at what is left, from the end of the composer's hint line.
 *
 * The panel is drawn from whatever windows the daemon reports rather than a
 * list written down here, so a window Anthropic adds later arrives on its
 * own. These tests hold that open.
 */

const SPENT = {
  available: true,
  windows: [
    { key: "five_hour", label: "5-hour", percent: 41, resetsAt: "2026-08-25T14:20:00Z" },
    { key: "seven_day", label: "7-day", percent: 68, resetsAt: null },
    { key: "seven_day_opus", label: "7-day Opus", percent: 96, resetsAt: null },
  ],
};

let ui: Cockpit;
afterEach(() => { ui?.unmount(); });

async function boot(over: Partial<Fixtures> = {}): Promise<void> {
  ui = await bootCockpit({ rows: [row()], ...over });
}

async function opened(over: Partial<Fixtures> = {}): Promise<void> {
  await boot(over);
  await waitFor(() => ui.$("#open-usage"), "the usage button");
  await ui.hover(ui.$("#open-usage"));
  await waitFor(() => ui.$("#usage-panel"), "the usage panel");
}

describe("the usage icon in the composer", () => {
  it("is not there at all when the daemon has nothing to report", async () => {
    // No oauth credential is the ordinary case, not a failure. An icon that
    // only ever says "unavailable" is an icon that has to be read to be
    // ignored.
    await boot();

    expect(ui.$("#open-usage")).toBeNull();
  });

  it("appears once there is something to say", async () => {
    await boot({ usage: SPENT });

    await waitFor(() => ui.$("#open-usage"), "the usage button");
  });

  it("keeps the panel shut until it is hovered", async () => {
    await boot({ usage: SPENT });
    await waitFor(() => ui.$("#open-usage"), "the usage button");

    expect(ui.$("#usage-panel")).toBeNull();
  });
});

describe("the mark on the button", () => {
  /** The columns, tallest-first in the DOM order the daemon named them. */
  const columns = () => ui.$$(".usage-mark path");
  /** How tall a column is drawn, in the icon's own units. */
  const height = (path: Element) => 12.6 - Number(path.getAttribute("d")!.split("V")[1]);

  it("draws a column per window the daemon named, not three for ever", async () => {
    await boot({ usage: { available: true, windows: [SPENT.windows[0], SPENT.windows[1]] } });
    await waitFor(() => ui.$("#open-usage"), "the usage button");

    expect(columns()).toHaveLength(2);
  });

  it("draws each column as tall as its window is full", async () => {
    await boot({ usage: SPENT });
    await waitFor(() => ui.$("#open-usage"), "the usage button");

    // 41, 68, 96 - so each column is taller than the one before it.
    const tall = columns().map(height);
    expect(tall[0]).toBeLessThan(tall[1]);
    expect(tall[1]).toBeLessThan(tall[2]);
  });

  it("still draws something for a window with almost nothing spent", async () => {
    await boot({ usage: { available: true, windows: [{ ...SPENT.windows[0], percent: 0 }] } });
    await waitFor(() => ui.$("#open-usage"), "the usage button");

    expect(height(columns()[0])).toBeGreaterThan(0);
  });

  it("stays chrome while there is room", async () => {
    await boot({ usage: { available: true, windows: [{ ...SPENT.windows[0], percent: 40 }] } });
    await waitFor(() => ui.$("#open-usage"), "the usage button");

    expect(ui.$(".usage-mark")!.dataset.tone).toBe("ok");
  });

  it("turns as the fullest window turns, not as the average does", async () => {
    // Two windows barely touched and one nearly gone is not a comfortable
    // afternoon, whatever the mean says.
    await boot({ usage: SPENT });
    await waitFor(() => ui.$("#open-usage"), "the usage button");

    expect(ui.$(".usage-mark")!.dataset.tone).toBe("full");
  });

  it("warns before it stops you", async () => {
    await boot({ usage: { available: true, windows: [{ ...SPENT.windows[0], percent: 78 }] } });
    await waitFor(() => ui.$("#open-usage"), "the usage button");

    expect(ui.$(".usage-mark")!.dataset.tone).toBe("high");
  });

  it("says the number too, so colour is never the only thing carrying it", async () => {
    await boot({ usage: SPENT });
    await waitFor(() => ui.$("#open-usage"), "the usage button");

    expect(ui.$("#open-usage")!.getAttribute("aria-label")).toBe("7-day Opus: 96% spent");
  });

  it("keeps its shape, and no colour, when there are no numbers to draw", async () => {
    await boot({ usage: { available: false, reason: "refused" } });
    await waitFor(() => ui.$("#open-usage"), "the usage button");

    expect(columns()).toHaveLength(3);
    expect(ui.$(".usage-mark")!.dataset.tone).toBeUndefined();
  });
});

describe("keeping up to date", () => {
  afterEach(() => { vi.useRealTimers(); });

  it("asks again on a clock, because a mark you have to hover cannot warn you", async () => {
    vi.useFakeTimers();
    await boot({ usage: SPENT });
    const before = ui.fetched.filter((url) => url.includes("/api/usage")).length;

    await ui.run(() => { vi.advanceTimersByTime(60_000); });

    expect(ui.fetched.filter((url) => url.includes("/api/usage")).length).toBe(before + 1);
  });

  it("leaves a hidden tab alone", async () => {
    vi.useFakeTimers();
    await boot({ usage: SPENT });
    const before = ui.fetched.filter((url) => url.includes("/api/usage")).length;

    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    await ui.run(() => { vi.advanceTimersByTime(300_000); });
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });

    expect(ui.fetched.filter((url) => url.includes("/api/usage")).length).toBe(before);
  });
});

describe("the panel", () => {
  it("draws a bar for every window the daemon named", async () => {
    await opened({ usage: SPENT });

    expect(ui.$$(".usage-row")).toHaveLength(3);
    expect(ui.$("#usage-panel")!.textContent).toContain("7-day Opus");
  });

  it("draws a window it has never heard of, without being taught it", async () => {
    await opened({
      usage: { available: true, windows: [{ key: "seven_day_fable", label: "7-day fable", percent: 12, resetsAt: null }] },
    });

    expect(ui.$("#usage-panel")!.textContent).toContain("7-day fable");
  });

  it("makes the bar as wide as the window is full", async () => {
    await opened({ usage: SPENT });

    expect(ui.$$(".usage-fill")[0].style.width).toBe("41%");
    expect(ui.$$(".usage-fill")[1].style.width).toBe("68%");
  });

  it("says the number too, so the bar is never the only thing carrying it", async () => {
    await opened({ usage: SPENT });

    expect(ui.$$(".usage-row")[0].textContent).toContain("41%");
  });

  it("colours a window by how close it is to full", async () => {
    // The same three steps the context ring uses, and the same tokens, so a
    // theme that moves its hues moves this with it.
    await opened({ usage: SPENT });
    const tone = ui.$$(".usage-row").map((el) => el.dataset.tone);

    expect(tone).toEqual(["ok", "ok", "full"]);
  });

  it("says when a window turns over, when the daemon knows", async () => {
    await opened({ usage: SPENT });

    expect(ui.$$(".usage-row")[0].textContent).toMatch(/resets/i);
    expect(ui.$$(".usage-row")[1].textContent).not.toMatch(/resets/i);
  });

  it("shuts again when the pointer leaves", async () => {
    await opened({ usage: SPENT });

    await ui.unhover(ui.$("#open-usage"));

    expect(ui.$("#usage-panel")).toBeNull();
  });

  it("says so plainly when the credential has gone stale", async () => {
    await boot({ usage: { available: false, reason: "refused" } });
    await waitFor(() => ui.$("#open-usage"), "the usage button");
    await ui.hover(ui.$("#open-usage"));

    await waitFor(() => ui.$("#usage-panel"), "the usage panel");
    expect(ui.$("#usage-panel")!.textContent).toMatch(/log in|expired|turned away/i);
  });
});
