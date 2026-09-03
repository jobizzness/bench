/**
 * @vitest-environment jsdom
 * @vitest-environment-options { "url": "http://localhost/?token=t" }
 */
import { describe, it, expect, afterEach } from "vitest";
import { bootCockpit, entry, row, type Cockpit } from "./helpers/cockpit.js";

/**
 * The thread used to mount every entry a specialist ever produced - 237 of
 * them on the worst session on this bench, 3048 DOM nodes for #thread alone
 * (#68). A conversation is never truncated on disk; only what React mounts
 * is bounded, and older entries stay a click away rather than missing.
 */

let ui: Cockpit;
afterEach(() => {
  ui?.unmount();
  history.pushState({}, "", "/?token=t");
});

const thread = () => ui.$("#thread")!;
const entries = (n: number) => Array.from({ length: n }, (_, i) => entry({ seq: i + 1, body: `entry ${i + 1}` }));

describe("windowing the thread", () => {
  it("renders every entry and no button when the thread is under the window", async () => {
    ui = await bootCockpit({ rows: [row()], entries: entries(10) });
    await ui.open("auth");

    expect(ui.$$(".entry")).toHaveLength(10);
    expect(ui.$("#thread-load-older")).toBeNull();
    expect(thread().textContent).toContain("entry 1");
    expect(thread().textContent).toContain("entry 10");
  });

  it("mounts only the newest entries once the thread is long, with a way back to the rest", async () => {
    ui = await bootCockpit({ rows: [row()], entries: entries(25) });
    await ui.open("auth");

    const shown = ui.$$(".entry").map((n) => n.textContent);
    expect(shown).toHaveLength(12);
    // Entries 1-13 are the oldest and unmounted; 14-25 are the window.
    expect(shown.some((t) => t?.includes("entry 13"))).toBe(false);
    expect(shown.some((t) => t?.includes("entry 14"))).toBe(true);
    expect(shown.some((t) => t?.includes("entry 25"))).toBe(true);

    const button = ui.$("#thread-load-older");
    expect(button).not.toBeNull();
    expect(button!.textContent).toContain("Show 13 earlier");
  });

  it("lands on the newest entry, same as a thread that was never windowed", async () => {
    ui = await bootCockpit({ rows: [row()], entries: entries(25) });
    await ui.open("auth");

    const shown = ui.$$(".entry").map((n) => n.textContent);
    expect(shown[shown.length - 1]).toContain("entry 25");
  });

  it("reveals everything, in order, once the button is pressed - and the button then disappears", async () => {
    ui = await bootCockpit({ rows: [row()], entries: entries(25) });
    await ui.open("auth");

    await ui.click(ui.$("#thread-load-older"));

    const shown = ui.$$(".entry").map((n) => n.textContent);
    expect(shown).toHaveLength(25);
    expect(shown[0]).toContain("entry 1");
    expect(shown[24]).toContain("entry 25");
    expect(ui.$("#thread-load-older")).toBeNull();
  });

  it("does not carry an expanded thread from one specialist onto the next", async () => {
    ui = await bootCockpit({
      rows: [row({ id: "s1", label: "first" }), row({ id: "s2", label: "second" })],
      entries: entries(25),
    });

    await ui.open("first");
    await ui.click(ui.$("#thread-load-older"));
    expect(ui.$("#thread-load-older")).toBeNull();

    await ui.open("second");
    expect(ui.$("#thread-load-older")).not.toBeNull();
    expect(ui.$$(".entry")).toHaveLength(12);
  });
});
