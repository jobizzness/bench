/**
 * @vitest-environment jsdom
 * @vitest-environment-options { "url": "http://localhost/?token=t" }
 */
import { describe, it, expect, afterEach } from "vitest";
import { bootCockpit, row, type Cockpit, type Fixtures } from "./helpers/cockpit.js";
import { waitFor } from "./helpers/wait-for.js";

/**
 * What the turn you are about to send will be spent from.
 *
 * The meter at the end of the composer used to report the Anthropic
 * subscription whatever the specialist was running on - so a specialist on
 * Gemini sat beside a bar about an account that turn would never touch. Which
 * account is being spent follows the model, because they are the same
 * question.
 */

const SPENT = {
  available: true,
  windows: [{ key: "five_hour", label: "5-hour", percent: 41, resetsAt: null }],
};

const CREDIT = { available: true, spent: 12.4, limit: 50 };

let ui: Cockpit;
afterEach(() => { ui?.unmount(); });

async function boot(over: Partial<Fixtures>): Promise<void> {
  ui = await bootCockpit({ rows: [row({ model: "opus" })], usage: SPENT, credit: CREDIT, ...over });
  await ui.open("auth");
}

/** Open whichever meter is there and read the panel. */
async function panel(): Promise<string> {
  await waitFor(() => ui.$("#open-usage"), "the meter");
  await ui.hover(ui.$("#open-usage"));
  await waitFor(() => ui.$("#usage-panel"), "the panel");
  return ui.$("#usage-panel")!.textContent ?? "";
}

describe("which account the meter reports", () => {
  it("is the Anthropic subscription for a specialist running on Anthropic", async () => {
    await boot({ rows: [row({ model: "opus" })] });

    expect(await panel()).toContain("5-hour");
  });

  it("is the OpenRouter key for a specialist running through OpenRouter", async () => {
    // The turn is billed there and not to the subscription, so the
    // subscription's windows are the wrong answer however true they are.
    await boot({ rows: [row({ model: "google/gemini-3.7-flash" })] });

    const said = await panel();
    expect(said).toContain("$12.40");
    expect(said).toContain("$50.00");
    expect(said).not.toContain("5-hour");
  });

  it("follows the specialist you switch to", async () => {
    ui = await bootCockpit({
      rows: [
        row({ id: "s1", label: "auth", model: "opus" }),
        row({ id: "s2", label: "billing", model: "google/gemini-3.7-flash" }),
      ],
      usage: SPENT,
      credit: CREDIT,
    });

    await ui.open("auth");
    expect(await panel()).toContain("5-hour");

    await ui.open("billing");
    expect(await panel()).toContain("$12.40");
  });
});

describe("the OpenRouter meter", () => {
  it("says the spend against the ceiling", async () => {
    await boot({ rows: [row({ model: "google/gemini-3.7-flash" })] });

    expect(await panel()).toContain("$12.40 of $50.00 used");
  });

  it("says only the spend for a key with no ceiling", async () => {
    // Pay-as-you-go, which is the common case. There is no fraction to draw.
    await boot({
      rows: [row({ model: "google/gemini-3.7-flash" })],
      credit: { available: true, spent: 3, limit: null },
    });

    const said = await panel();
    expect(said).toContain("$3.00");
    expect(said).toContain("no ceiling on this key");
    // No ceiling means no fraction, so nothing is said against one.
    expect(said).not.toContain("of $");
    expect(ui.$(".usage-track")).toBeNull();
  });

  it("is not there at all when the bench holds no OpenRouter key", async () => {
    // Nothing to report is the ordinary case for a bench that has never set
    // one, and a meter whose only answer is "unavailable" has to be read
    // before it can be ignored.
    await boot({
      rows: [row({ model: "google/gemini-3.7-flash" })],
      credit: { available: false, reason: "none" },
    });

    expect(ui.$("#open-usage")).toBeNull();
  });

  it("says a turned-away key is the thing to fix", async () => {
    await boot({
      rows: [row({ model: "google/gemini-3.7-flash" })],
      credit: { available: false, reason: "refused" },
    });

    expect(await panel()).toMatch(/turned away/i);
  });

  it("says a key it could not ask about is not a key that is wrong", async () => {
    await boot({
      rows: [row({ model: "google/gemini-3.7-flash" })],
      credit: { available: false, reason: "unreachable" },
    });

    expect(await panel()).toMatch(/could not reach/i);
  });

  it("carries the number on the button too, not only inside the panel", async () => {
    // A pointer resting on it, or a screen reader passing over it, gets the
    // answer without opening anything.
    await boot({ rows: [row({ model: "google/gemini-3.7-flash" })] });
    await waitFor(() => ui.$("#open-usage"), "the meter");

    expect(ui.$("#open-usage")!.getAttribute("aria-label")).toBe("OpenRouter: $12.40 of $50.00 used");
  });
});
