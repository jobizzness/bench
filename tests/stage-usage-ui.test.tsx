/**
 * @vitest-environment jsdom
 * @vitest-environment-options { "url": "http://localhost/?token=t" }
 */
import { describe, it, expect, afterEach } from "vitest";
import { bootCockpit, row, type Cockpit } from "./helpers/cockpit.js";

/**
 * The five-hour window, said on the header itself once it is worth
 * interrupting a developer over - not just on a hover at the end of the
 * composer.
 */

const usage = (percent: number) => ({
  available: true,
  windows: [{ key: "five_hour", label: "5-hour", percent, resetsAt: null }],
});

let ui: Cockpit;
afterEach(() => { ui?.unmount(); });

async function opened(fixtures: Parameters<typeof bootCockpit>[0]): Promise<void> {
  ui = await bootCockpit({ rows: [row()], ...fixtures });
  await ui.open("auth");
}

describe("the five-hour usage bar on the stage header", () => {
  it("stays off the header while there is plenty of room", async () => {
    await opened({ usage: usage(41) });

    expect(ui.$("#stage-head .stage-usage")).toBeNull();
  });

  it("appears once the five-hour window passes 60%", async () => {
    await opened({ usage: usage(62) });

    expect(ui.$("#stage-head .stage-usage")).not.toBeNull();
  });

  it("draws the bar as wide as the window is full", async () => {
    await opened({ usage: usage(62) });

    expect((ui.$(".stage-usage-fill") as HTMLElement).style.width).toBe("62%");
  });

  it("says the number too, so colour is never the only thing carrying it", async () => {
    await opened({ usage: usage(62) });

    expect(ui.$(".stage-usage")!.textContent).toContain("62%");
  });

  it("is silent when the daemon has nothing to report", async () => {
    await opened({});

    expect(ui.$("#stage-head .stage-usage")).toBeNull();
  });
});
