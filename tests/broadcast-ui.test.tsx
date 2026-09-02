/**
 * @vitest-environment jsdom
 * @vitest-environment-options { "url": "http://localhost/?token=t" }
 */
import { describe, it, expect, afterEach } from "vitest";
import { bootCockpit, row, type Cockpit } from "./helpers/cockpit.js";

/**
 * The one control that puts a specialist's work outside this machine.
 *
 * It is a mark rather than a word, so the state it carries lives entirely in
 * `aria-pressed` and the label - there is no text to read it off. These
 * assert the things a screen reader and a keyboard user actually get, which
 * is the half a screenshot would not show.
 */

let ui: Cockpit;
afterEach(() => { ui?.unmount(); });

async function opened(broadcast: boolean): Promise<HTMLButtonElement> {
  ui = await bootCockpit({ rows: [row({ id: "auth", broadcast })] });
  await ui.open("auth");
  return ui.$("#broadcast-toggle") as HTMLButtonElement;
}

describe("the broadcast toggle", () => {
  it("is off, and says so, on a specialist that has never been broadcast", async () => {
    const button = await opened(false);

    expect(button.getAttribute("aria-pressed")).toBe("false");
    expect(button.getAttribute("aria-label")).toContain("Not reachable");
  });

  it("is pressed, and says what that means, once it is on", async () => {
    const button = await opened(true);

    expect(button.getAttribute("aria-pressed")).toBe("true");
    expect(button.getAttribute("aria-label")).toContain("Reachable from your other devices");
  });

  /* The icon has no text to fall back on, so a label that ever goes missing
   * leaves a button nobody can identify. Worth one assertion of its own. */
  it("always carries a label, whichever way it is set", async () => {
    for (const state of [false, true]) {
      const button = await opened(state);
      expect(button.getAttribute("aria-label")?.length ?? 0).toBeGreaterThan(0);
      ui.unmount();
    }
  });

  it("asks the daemon to turn it on, and does not decide for itself", async () => {
    const button = await opened(false);
    await ui.click(button);

    const last = ui.sent.at(-1)!;
    expect(last.url).toContain("/api/sessions/auth/broadcast");
    expect(last.body).toEqual({ broadcast: true });
    // The roster carries the new value back; nothing is assumed locally.
    expect(button.getAttribute("aria-pressed")).toBe("false");
  });

  it("asks for it to be turned off when it is already on", async () => {
    const button = await opened(true);
    await ui.click(button);

    expect(ui.sent.at(-1)!.body).toEqual({ broadcast: false });
  });
});
