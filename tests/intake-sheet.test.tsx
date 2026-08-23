/**
 * @vitest-environment jsdom
 * @vitest-environment-options { "url": "http://localhost/?token=t" }
 */
import { describe, it, expect, afterEach } from "vitest";
import type { Decision } from "../src/shared/types.js";
import { bootCockpit, entry, row, type Cockpit } from "./helpers/cockpit.js";

/**
 * The questionnaire used to live in the composer, where it was capped at half
 * the viewport and the checklist was hidden to make room for it. It is a sheet
 * now — which only works if closing it is safe and reopening it is obvious.
 */

const ASKS = { expiry: "How long should a reset token live?", audit: "Log every reset?" };

const DECISION: Decision = {
  kind: "intake",
  title: "Password reset — before I build",
  summary: "Two questions, one I've answered.",
  options: [],
  allowFreeText: true,
  questions: [
    {
      id: "expiry", ask: ASKS.expiry, stakes: "high", select: "one", allowFreeText: true,
      options: [{ id: "15m", label: "15 minutes", default: true }, { id: "1h", label: "1 hour" }],
    },
    {
      id: "audit", ask: ASKS.audit, stakes: "high", select: "one", allowFreeText: true,
      options: [{ id: "yes", label: "Yes" }, { id: "no", label: "No" }],
    },
  ],
};

let ui: Cockpit;
afterEach(() => {
  ui?.unmount();
  history.pushState({}, "", "/?token=t");
});

const sheet = () => ui.$<HTMLDialogElement>("#intake-dialog");
const card = () => ui.$<HTMLButtonElement>("#intake-card");
const isOpen = () => sheet()?.hasAttribute("open") === true;
const optionsFor = (ask: string) => {
  const question = ui.$$(".question").find((c) => c.querySelector(".q-ask")?.textContent === ask)!;
  return [...question.querySelectorAll<HTMLButtonElement>("button.option")];
};

async function open(): Promise<void> {
  ui = await bootCockpit({
    rows: [row({ label: "reset", latestReportSeq: 1, answeredReportSeq: null })],
    entries: [entry({ body: "add password reset" })],
    decision: DECISION,
  });
  await ui.open("reset");
}

describe("the intake as a sheet", () => {
  it("opens by itself when the specialist asks", async () => {
    // Being asked must not depend on noticing something in a footer.
    await open();
    expect(isOpen()).toBe(true);
  });

  it("leaves a card behind when you close it", async () => {
    await open();
    await ui.click(ui.$("#intake-later"));

    expect(isOpen()).toBe(false);
    expect(card()!.textContent).toContain("Password reset — before I build");
    expect(card()!.textContent).toContain("1 of 2 still needs you");
  });

  it("keeps what you picked when it is closed and opened again", async () => {
    // Closing is not answering, and it is not discarding either.
    await open();
    await ui.click(optionsFor(ASKS.audit)[1]);
    await ui.click(ui.$("#intake-later"));
    await ui.click(card());

    expect(isOpen()).toBe(true);
    expect(optionsFor(ASKS.audit)[1].getAttribute("aria-pressed")).toBe("true");
    expect(card()!.textContent).toContain("2 questions, all answered");
  });

  it("stops the number keys while it is closed", async () => {
    // Otherwise pressing 2 rewrites an answer that is nowhere on screen.
    await open();
    await ui.click(ui.$("#intake-later"));
    await ui.press("2");
    await ui.click(card());

    expect(optionsFor(ASKS.expiry)[1].getAttribute("aria-pressed")).toBe("false");
  });

  it("leaves the composer beneath it as a way to say something", async () => {
    // A specialist waiting on an intake can still be told something else.
    await open();
    await ui.click(ui.$("#intake-later"));
    await ui.type(ui.$("#composer-text"), "actually, drop the mobile flow");
    await ui.pressIn(ui.$("#composer-text"), "Enter");

    const sent = ui.sent.at(-1)!;
    expect(sent.url).toContain("/message");
    expect(sent.body.text).toBe("actually, drop the mobile flow");
  });

  it("takes both the sheet and the card away once it is answered", async () => {
    await open();
    await ui.click(optionsFor(ASKS.audit)[0]);
    await ui.click(ui.$("#intake-send"));

    expect(sheet()).toBeNull();
    expect(card()).toBeNull();
  });
});
