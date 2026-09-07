/**
 * @vitest-environment jsdom
 * @vitest-environment-options { "url": "http://localhost/?token=t" }
 */
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { bootCockpit, entry, row, type Cockpit } from "./helpers/cockpit.js";
import { waitFor } from "./helpers/wait-for.js";

/**
 * A burst of sends gets a plane and an escalating glow (#103) - this is the
 * wiring in App.tsx and Composer.tsx, not `useSendBurst`'s own level
 * machine (tests/send-burst.test.tsx) or the plane module's own DOM
 * lifecycle (tests/fly-send-mark.test.ts).
 */

let ui: Cockpit;
let vibrate: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vibrate = vi.fn();
  Object.defineProperty(navigator, "vibrate", { value: vibrate, configurable: true, writable: true });
});

afterEach(() => {
  ui?.unmount();
  history.pushState({}, "", "/?token=t");
  document.querySelectorAll(".send-fly").forEach((el) => el.remove());
  // @ts-expect-error - test-only teardown of a property this suite defined.
  delete navigator.vibrate;
  vi.useRealTimers();
});

const box = () => ui.$<HTMLTextAreaElement>("#composer-text")!;
const form = () => ui.$("#composer-form")!;
const planes = () => document.querySelectorAll(".send-fly");

async function open(): Promise<void> {
  ui = await bootCockpit({
    rows: [row({ status: "done", detail: "idle" })],
    entries: [entry()],
  });
  await ui.open("auth");
  // jsdom lays nothing out, so the field's own rect is zero by default - the
  // exact case the plane module falls back from. Give it real geometry so
  // sending here draws a plane the way an actual browser would.
  box().getBoundingClientRect = () => ({
    x: 10, y: 10, width: 280, height: 30, top: 10, left: 10, right: 290, bottom: 40,
    toJSON: () => ({}),
  });
}

async function send(text: string): Promise<void> {
  await ui.type(box(), text);
  await ui.pressIn(box(), "Enter");
}

describe("the composer's glow", () => {
  it("marks level 1 for a single send, which styles.css leaves undecorated - a streak of one is not a streak", async () => {
    await open();
    await send("one");

    expect(form().getAttribute("data-burst")).toBe("1");
  });

  it("reaches 2 on a second send that follows closely", async () => {
    await open();
    await send("one");
    await send("two");

    expect(form().getAttribute("data-burst")).toBe("2");
  });

  it("reaches 3 on a third send that follows closely", async () => {
    await open();
    await send("one");
    await send("two");
    await send("three");

    expect(form().getAttribute("data-burst")).toBe("3");
  });

  it("decays back to nothing 6s after the last send", async () => {
    vi.useFakeTimers();
    await open();
    await send("one");
    await send("two");
    expect(form().getAttribute("data-burst")).toBe("2");

    await ui.run(() => { vi.advanceTimersByTime(6000); });

    expect(form().getAttribute("data-burst")).toBeNull();
  });
});

describe("the burst haptic", () => {
  it("fires the ascending pattern once the burst first reaches 3", async () => {
    await open();
    await send("one");
    await send("two");
    vibrate.mockClear();
    await send("three");

    expect(vibrate).toHaveBeenCalledWith([10, 30, 10, 30, 20]);
  });

  it("does not fire again on a fourth send that merely stays at 3", async () => {
    await open();
    await send("one");
    await send("two");
    await send("three");
    vibrate.mockClear();
    await send("four");

    expect(vibrate.mock.calls.some((call) => Array.isArray(call[0]) && call[0].length === 5)).toBe(false);
  });
});

describe("the plane", () => {
  it("launches one on an ordinary send", async () => {
    await open();
    await send("one");

    expect(planes().length).toBeGreaterThanOrEqual(1);
  });

  it("throws extra planes once the burst reaches 3", async () => {
    await open();
    await send("one");
    await send("two");
    await send("three");

    await waitFor(() => (planes().length >= 3 ? planes() : null), "the burst's extra planes");
  });
});
