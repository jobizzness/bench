/**
 * @vitest-environment jsdom
 * @vitest-environment-options { "url": "http://localhost/?token=t" }
 */
import { describe, it, expect, afterEach } from "vitest";
import type { Decision } from "../src/shared/types.js";
import { bootCockpit, row, type Cockpit } from "./helpers/cockpit.js";
import { waitFor } from "./helpers/wait-for.js";

/**
 * Six specialists working at once are only as fast as the queue in front of
 * one person. What these hold in place is that answering one moves to the
 * next without leaving the queue - and that a questionnaire, which is a page
 * of its own, is handed over rather than rushed.
 */

const plain = (title: string): Decision => ({
  kind: "completion",
  title,
  summary: "Built and pushed.",
  options: [
    { id: "ship", label: "Merge it" },
    { id: "hold", label: "Hold it" },
  ],
  questions: [],
  allowFreeText: true,
});

const intake: Decision = {
  kind: "intake",
  title: "Password reset — before I build",
  summary: "Two questions.",
  options: [],
  allowFreeText: true,
  questions: [{
    id: "expiry", ask: "How long should a token live?", stakes: "high",
    select: "one", allowFreeText: true,
    options: [{ id: "15m", label: "15 minutes" }, { id: "1h", label: "1 hour" }],
  }],
};

const waitingRow = (over: Parameters<typeof row>[0] = {}) =>
  row({ latestReportSeq: 1, answeredReportSeq: null, status: "awaiting_decision", ...over });

let ui: Cockpit;
afterEach(() => {
  ui?.unmount();
  history.pushState({}, "", "/?token=t");
});

const items = () => ui.$$(".queue-item");
const answers = () => ui.sent.filter((s) => s.url.includes("/answer"));

async function open(decision: Decision | null = plain("The composer")): Promise<void> {
  ui = await bootCockpit({
    rows: [
      waitingRow({ id: "a", label: "ui-designer", project: "/var/www/bench" }),
      waitingRow({ id: "b", label: "payouts", project: "/var/www/teledoctor" }),
    ],
    decision,
  });
  await ui.click(ui.$("#open-queue"));
  await waitFor(() => ui.$("#queue-current"), "the queue");
}

describe("the queue", () => {
  it("stays out of the way until something is waiting", async () => {
    ui = await bootCockpit({ rows: [row({ status: "working", latestReportSeq: null })] });
    expect(ui.$("#open-queue")).toBeNull();
  });

  it("counts what wants you, across every project", async () => {
    ui = await bootCockpit({ rows: [
      waitingRow({ id: "a", project: "/var/www/bench" }),
      waitingRow({ id: "b", project: "/var/www/teledoctor" }),
      row({ id: "c", status: "working", latestReportSeq: null }),
    ] });

    // A brain and a number: what is waiting is a judgement to make, not a
    // message that arrived, and only the count changes. The word moved to
    // the accessible name, which is where it is read out.
    const button = ui.$("#open-queue")!;
    expect(button.textContent).toBe("2");
    expect(button.getAttribute("aria-label")).toBe("2 waiting on you");
    expect(button.querySelector("svg.brain-mark")).not.toBeNull();
  });

  it("lists them with where each one is from", async () => {
    await open();

    expect(items()).toHaveLength(2);
    expect(items()[0].textContent).toContain("bench · ui-designer");
    expect(items()[1].textContent).toContain("teledoctor · payouts");
  });

  it("answers the one in front of you and moves to the next", async () => {
    // The walking is the thing this removes: no going back to the roster
    // between two decisions.
    await open();
    expect(ui.$("#queue-current-title")!.textContent).toBe("The composer");

    await ui.click(ui.$$(".option")[0]);
    await ui.click(ui.$("#queue-answer"));

    expect(answers()).toHaveLength(1);
    expect(answers()[0].url).toContain("/api/sessions/a/answer");
    expect(answers()[0].body).toEqual({ optionId: "ship", text: "" });
    // One gone, one left, and the one left is now in front of you.
    expect(items()).toHaveLength(1);
    expect(items()[0].textContent).toContain("teledoctor · payouts");
  });

  it("takes an answer in your own words", async () => {
    await open();
    await ui.type(ui.$("#queue-text"), "neither - split it in two");
    await ui.click(ui.$("#queue-answer"));

    expect(answers()[0].body).toEqual({ optionId: null, text: "neither - split it in two" });
  });

  it("refuses to send nothing", async () => {
    await open();
    expect(ui.$<HTMLButtonElement>("#queue-answer")!.disabled).toBe(true);
  });

  it("hands a questionnaire over rather than rushing it here", async () => {
    // An intake has a brief that rewrites itself as you answer. Squeezing one
    // into a queue is how a default nobody read gets sent.
    await open(intake);

    expect(ui.$("#queue-options")).toBeNull();
    expect(ui.$("#queue-current")!.textContent).toContain("wants the whole page");
    expect(ui.$("#queue-open")).not.toBeNull();
  });

  it("opens the specialist when handing over, and closes behind itself", async () => {
    await open(intake);
    await ui.click(ui.$("#queue-open"));

    expect(location.pathname).toBe("/s/a");
    expect(ui.$<HTMLDialogElement>("#queue")!.hasAttribute("open")).toBe(false);
  });

  it("says so when a report cannot be read, rather than showing an empty answer", async () => {
    await open(null);
    expect(ui.$("#queue-current")!.textContent).toContain("did not parse");
  });

  it("lets you jump to one further down the list", async () => {
    await open();
    await ui.click(items()[1]);

    expect(ui.$("#queue-current")!.textContent).toContain("teledoctor · payouts");
  });
});

describe("read it, press one key", () => {
  it("picks an option by number", async () => {
    await open();
    await ui.press("2");

    expect(ui.$$(".option")[1].getAttribute("aria-pressed")).toBe("true");
  });

  it("sends on Enter and lands on the next one", async () => {
    await open();
    await ui.press("1");
    await ui.press("Enter");

    expect(answers()).toHaveLength(1);
    expect(answers()[0].body.optionId).toBe("ship");
    expect(ui.$("#queue-current")!.textContent).toContain("teledoctor · payouts");
  });

  it("refuses Enter while nothing is chosen", async () => {
    await open();
    await ui.press("Enter");
    expect(answers()).toHaveLength(0);
  });

  it("leaves the keys alone while you are typing an answer", async () => {
    // "2 of them" is a sentence, not a keystroke.
    await open();
    await ui.type(ui.$("#queue-text"), "2");
    await ui.pressIn(ui.$("#queue-text"), "2");

    expect(ui.$$(".option")[1].getAttribute("aria-pressed")).toBe("false");
  });
});
