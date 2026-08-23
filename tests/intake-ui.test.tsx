/**
 * @vitest-environment jsdom
 * @vitest-environment-options { "url": "http://localhost/?token=t" }
 */
import { describe, it, expect, afterEach } from "vitest";
import { decisionSchema } from "../src/shared/types.js";
import { bootCockpit, entry, row, type Cockpit } from "./helpers/cockpit.js";

/**
 * The intake, driven through the real cockpit rather than a copy of its
 * logic. `intake.test.ts` covers the rules; this covers the wiring — that a
 * key reaches the right question, that the send bar refuses, and that what is
 * posted at the end says which answers were actually the developer's.
 */

const ASKS = {
  expiry: "How long should a reset token live?",
  flows: "Which entry points get it?",
  audit: "Log resets to the audit trail?",
  ratelimit: "Rate limit the endpoint?",
};

const DECISION = decisionSchema.parse({
  kind: "intake",
  title: "Password reset — before I build",
  summary: "Four questions. One I could not guess.",
  brief: "Links expire after {expiry}, cover {flows}, and requests are {ratelimit}.",
  questions: [
    {
      id: "expiry", ask: ASKS.expiry, why: "Sets the email copy.",
      options: [
        { id: "15m", label: "15 minutes", hint: "Matches the login OTP." },
        { id: "1h", label: "1 hour", default: true },
      ],
    },
    {
      id: "flows", ask: ASKS.flows, select: "many",
      options: [{ id: "web", label: "Web", default: true }, { id: "mobile", label: "Mobile" }],
    },
    {
      id: "audit", ask: ASKS.audit,
      options: [{ id: "yes", label: "Yes" }, { id: "no", label: "No" }],
    },
    {
      id: "ratelimit", ask: ASKS.ratelimit, stakes: "low",
      options: [{ id: "reuse", label: "the existing limiter", default: true }],
    },
  ],
});

const WAITING = row({ label: "reset", latestReportSeq: 1, answeredReportSeq: null });

let ui: Cockpit;
afterEach(() => ui?.unmount());

async function open(): Promise<Cockpit> {
  ui = await bootCockpit({
    rows: [WAITING],
    entries: [entry({ body: "add password reset" })],
    decision: DECISION,
  });
  await ui.open("reset");
  return ui;
}

const cards = () => ui.$$("#intake-questions .question");
const asked = () => cards().map((c) => c.querySelector(".q-ask")!.textContent);
const cardFor = (ask: string) => cards().find((c) => c.querySelector(".q-ask")!.textContent === ask)!;
const optionsFor = (ask: string) => [...cardFor(ask).querySelectorAll<HTMLButtonElement>("button.option")];
const pressedIn = (ask: string) => optionsFor(ask).map((b) => b.getAttribute("aria-pressed"));
const send = () => ui.$<HTMLButtonElement>("#intake-send")!;
const brief = () => ui.$("#intake-brief")!.textContent;

describe("the intake panel", () => {
  it("shows every question the specialist could not fold away, at once", async () => {
    await open();
    expect(cards()).toHaveLength(3);
    expect(ui.$("#intake-assumed-count")!.textContent).toBe("1 more I've already assumed");
    expect(ui.$("#intake-assumed-preview")!.textContent).toBe("the existing limiter");
  });

  it("leads with the question the specialist could not guess", async () => {
    await open();
    expect(asked()).toEqual([ASKS.audit, ASKS.expiry, ASKS.flows]);
  });

  it("never renders the plain option row beside it", async () => {
    await open();
    expect(ui.$("#decision-options")).toBeNull();
  });

  it("pre-selects the specialist's own picks and labels them as its own", async () => {
    await open();
    const [fifteen, hour] = optionsFor(ASKS.expiry);
    expect(hour.getAttribute("aria-pressed")).toBe("true");
    expect(fifteen.getAttribute("aria-pressed")).toBe("false");
    expect(hour.textContent).toContain("mine");
    expect(fifteen.textContent).not.toContain("mine");
  });

  it("marks the question with no default as the one still needing the developer", async () => {
    await open();
    expect(cardFor(ASKS.audit).dataset.state).toBe("open");
    expect(cardFor(ASKS.audit).textContent).toContain("needs you");
    expect(cardFor(ASKS.expiry).dataset.state).toBe("assumed");
  });

  it("refuses to send while that question is unanswered, and says how many", async () => {
    await open();
    expect(send().disabled).toBe(true);
    expect(send().textContent).toBe("1 still needs you");
  });

  it("fills the brief's holes from the current answers", async () => {
    await open();
    expect(brief()).toBe("Links expire after 1 hour, cover Web, and requests are the existing limiter.");
  });
});

describe("answering it with a mouse", () => {
  it("rewrites the brief as an option is chosen", async () => {
    await open();
    await ui.click(optionsFor(ASKS.expiry)[0]);

    expect(brief()).toContain("expire after 15 minutes");
    expect(ui.$$("#intake-brief .slot")[0].dataset.state).toBe("changed");
  });

  it("adds rather than replaces on a multi-select question", async () => {
    await open();
    await ui.click(optionsFor(ASKS.flows)[1]);

    expect(pressedIn(ASKS.flows)).toEqual(["true", "true"]);
    expect(brief()).toContain("cover Web and Mobile");
  });

  it("replaces rather than adds on a single-select question", async () => {
    await open();
    await ui.click(optionsFor(ASKS.expiry)[0]);
    expect(pressedIn(ASKS.expiry)).toEqual(["true", "false"]);
  });

  it("does not reshuffle the questions as they are answered", async () => {
    await open();
    await ui.click(optionsFor(ASKS.audit)[0]);
    // A list that reorders under the cursor is unreadable.
    expect(asked()).toEqual([ASKS.audit, ASKS.expiry, ASKS.flows]);
  });

  it("unblocks the send bar once the last open question is answered", async () => {
    await open();
    await ui.click(optionsFor(ASKS.audit)[0]);

    expect(send().disabled).toBe(false);
    expect(send().textContent).toBe("Send 4 answers · 1 yours");
  });

  it("takes an answer typed in the developer's own words", async () => {
    await open();
    await ui.type(cardFor(ASKS.audit).querySelector("input.q-text"), "only for staff");

    expect(cardFor(ASKS.audit).dataset.state).toBe("changed");
    expect(send().disabled).toBe(false);
  });

  it("posts every answer, marking which ones were never touched", async () => {
    await open();
    await ui.click(optionsFor(ASKS.expiry)[0]);
    await ui.click(optionsFor(ASKS.flows)[1]);
    await ui.click(optionsFor(ASKS.audit)[0]);
    await ui.type(ui.$("#intake-note"), "keep the copy terse");
    await ui.click(send());

    const post = ui.sent.find((s) => s.url.includes("/answer"))!;
    expect(post.body.text).toBe("keep the copy terse");
    expect(post.body.answers).toEqual([
      { questionId: "expiry", ask: ASKS.expiry, labels: ["15 minutes"], text: "", defaulted: false },
      { questionId: "flows", ask: ASKS.flows, labels: ["Web", "Mobile"], text: "", defaulted: false },
      { questionId: "audit", ask: ASKS.audit, labels: ["Yes"], text: "", defaulted: false },
      { questionId: "ratelimit", ask: ASKS.ratelimit, labels: ["the existing limiter"], text: "", defaulted: true },
    ]);
  });

  it("takes the decision off the screen once it has been sent", async () => {
    await open();
    await ui.click(optionsFor(ASKS.audit)[0]);
    await ui.click(send());
    expect(ui.$("#intake")).toBeNull();
  });
});

describe("driving it from the keyboard", () => {
  it("starts focused on what blocks, and shows keycaps only there", async () => {
    await open();
    expect(cardFor(ASKS.audit).dataset.focused).toBe("true");
    expect(optionsFor(ASKS.audit)[0].querySelector(".key")!.textContent).toBe("1");
    // A key that would do nothing is a promise the app breaks.
    expect(optionsFor(ASKS.expiry)[0].querySelector(".key")).toBeNull();
  });

  it("refuses Enter while that question is unanswered", async () => {
    await open();
    await ui.press("Enter");

    expect(ui.sent.some((s) => s.url.includes("/answer"))).toBe(false);
    expect(cardFor(ASKS.audit).dataset.state).toBe("open");
  });

  it("picks within the focused question by number", async () => {
    await open();
    await ui.press("1");

    expect(pressedIn(ASKS.audit)).toEqual(["true", "false"]);
    expect(send().disabled).toBe(false);
  });

  it("moves focus with the arrows and retargets the number keys", async () => {
    await open();
    await ui.press("ArrowDown");
    expect(cardFor(ASKS.expiry).dataset.focused).toBe("true");

    await ui.press("1");
    expect(pressedIn(ASKS.expiry)).toEqual(["true", "false"]);
  });

  it("stops at the ends rather than wrapping", async () => {
    await open();
    await ui.press("ArrowUp");
    expect(cardFor(ASKS.audit).dataset.focused).toBe("true");
  });

  it("ignores number keys while the developer is typing an answer", async () => {
    await open();
    // Focus the question first, so a stray "1" would have somewhere to land.
    await ui.press("ArrowDown");
    expect(cardFor(ASKS.expiry).dataset.focused).toBe("true");

    // The key bubbles from the field, which is the guard the handler reads.
    await ui.pressIn(cardFor(ASKS.expiry).querySelector("input.q-text"), "1");
    expect(pressedIn(ASKS.expiry)).toEqual(["false", "true"]);

    // And the same key outside a field still picks, so the guard is not just
    // "the keyboard is off".
    await ui.press("1");
    expect(pressedIn(ASKS.expiry)).toEqual(["true", "false"]);
  });

  it("sends on Enter once nothing is outstanding", async () => {
    await open();
    await ui.press("1");
    await ui.press("Enter");

    const post = ui.sent.find((s) => s.url.includes("/answer"))!;
    expect(post.body.answers).toHaveLength(4);
    expect(post.body.answers[2]).toMatchObject({ questionId: "audit", labels: ["Yes"] });
  });
});

describe("while the developer is halfway through", () => {
  it("keeps a half-given answer across a roster tick", async () => {
    await open();
    await ui.press("1");
    await ui.type(cardFor(ASKS.expiry).querySelector("input.q-text"), "as short as you can");

    // The roster pushes constantly. Reloading the decision on every push used
    // to throw away whatever had been chosen since the last one.
    await ui.roster([{ ...WAITING, detail: "still ready", tokens: 900 }]);

    expect(pressedIn(ASKS.audit)).toEqual(["true", "false"]);
    expect(cardFor(ASKS.expiry).querySelector<HTMLInputElement>("input.q-text")!.value)
      .toBe("as short as you can");
  });

  it("drops the decision once the developer has answered that report", async () => {
    await open();
    expect(ui.$("#intake")).not.toBeNull();

    // An answered decision is not a decision: without this the same question
    // renders again the moment the specialist's next turn ends.
    await ui.roster([{ ...WAITING, answeredReportSeq: 1 }]);
    expect(ui.$("#intake")).toBeNull();
  });
});
