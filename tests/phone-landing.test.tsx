/**
 * @vitest-environment jsdom
 * @vitest-environment-options { "url": "http://localhost/?token=t" }
 */
import { describe, it, expect, afterEach } from "vitest";
import type { Decision } from "../src/shared/types.js";
import { bootCockpit, row, type Cockpit } from "./helpers/cockpit.js";
import { waitFor } from "./helpers/wait-for.js";

/**
 * On a phone the front door is whatever is waiting, not a roster you would
 * then have to navigate out of (#57). jsdom has no real viewport, so
 * `useNarrowViewport` is fed a fake `matchMedia` here rather than a resize -
 * what these hold in place is the decision, not the CSS: which of the
 * phone's four screens the developer lands on, and that landing on the
 * roster on purpose keeps it from steering afterward.
 */

function setNarrow(narrow: boolean): void {
  (window as unknown as { matchMedia: (query: string) => MediaQueryList }).matchMedia = ((query: string) => ({
    matches: narrow,
    media: query,
    onchange: null,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent: () => false,
  })) as unknown as (query: string) => MediaQueryList;
}

const plain = (title: string): Decision => ({
  kind: "completion",
  title,
  summary: "Built and pushed.",
  options: [{ id: "ship", label: "Merge it" }],
  questions: [],
  allowFreeText: true,
});

const intake: Decision = {
  kind: "intake",
  title: "Password reset — before I build",
  summary: "One question.",
  options: [],
  allowFreeText: true,
  questions: [{
    id: "expiry", ask: "How long should a token live?", stakes: "high",
    select: "one", allowFreeText: true,
    options: [{ id: "15m", label: "15 minutes" }],
  }],
};

const waitingRow = (over: Parameters<typeof row>[0] = {}) =>
  row({ latestReportSeq: 1, answeredReportSeq: null, status: "awaiting_decision", ...over });

const pane = () => ui.$("#app")?.getAttribute("data-pane");

let ui: Cockpit;
afterEach(() => {
  ui?.unmount();
  history.pushState({}, "", "/?token=t");
  delete (window as { matchMedia?: unknown }).matchMedia;
});

describe("landing on a phone", () => {
  it("above the breakpoint, opening the app never moves selectedId", async () => {
    setNarrow(false);
    ui = await bootCockpit({
      rows: [waitingRow({ id: "a", label: "alpha", project: "/var/www/bench" })],
      decision: plain("Ship it?"),
    });

    expect(pane()).toBe("roster");
    expect(ui.$("#unblock")).toBeNull();
  });

  it("lands on the one thing waiting, not the roster", async () => {
    setNarrow(true);
    ui = await bootCockpit({
      rows: [waitingRow({ id: "a", label: "alpha", project: "/var/www/bench" })],
      decision: plain("Ship it?"),
    });

    await waitFor(() => ui.$("#unblock"), "the unblock screen");
    expect(pane()).toBe("unblock");
    expect(ui.$("#unblock-title")!.textContent).toBe("Ship it?");
  });

  it("the report and the options are both there, unanswered", async () => {
    setNarrow(true);
    ui = await bootCockpit({
      rows: [waitingRow({ id: "a", label: "alpha", project: "/var/www/bench" })],
      decision: plain("Ship it?"),
    });

    await waitFor(() => ui.$("#unblock-frame"), "the inline report");
    expect(ui.$$("#unblock-options .option")).toHaveLength(1);
    expect(ui.$("#unblock-answer")).not.toBeNull();
  });

  it("holds the decision's shape while its report is still loading, not a bare header", async () => {
    setNarrow(true);
    ui = await bootCockpit({
      rows: [waitingRow({ id: "a", label: "alpha", project: "/var/www/bench" })],
      decisionHangs: true,
    });

    await waitFor(() => ui.$("#unblock"), "the unblock screen");
    // The header is real either way - what changes is everything under it.
    expect(ui.$("#unblock-head .eyebrow")).not.toBeNull();
    expect(ui.$("#unblock-title")).toBeNull();
    expect(ui.$(".unblock-title-skeleton")).not.toBeNull();
    expect(ui.$(".unblock-options-skeleton")).not.toBeNull();
  });

  it("nothing waiting opens on the empty screen, not a blank roster", async () => {
    setNarrow(true);
    ui = await bootCockpit({ rows: [row({ status: "working", latestReportSeq: null })] });
    await ui.connect();

    await waitFor(() => ui.$("#empty"), "the empty screen");
    expect(pane()).toBe("empty");
    expect(ui.$("#empty-title")!.textContent).toBe("Nothing needs you.");
  });

  it("shows the loading shape before the roster has ever settled, not the empty screen", async () => {
    // No `ui.connect()`: the socket has not so much as opened, so `live` is
    // still null - the exact state that used to render PhoneEmpty's "Nothing
    // needs you." before anything had arrived to say so (#80).
    setNarrow(true);
    ui = await bootCockpit({ rows: [] });

    expect(pane()).toBe("loading");
    expect(ui.$("#phone-loading")).not.toBeNull();
    // `#empty-title` rather than `#empty`: the thread has an element of that
    // id too, and it is on the page whenever the stage is - see #77.
    expect(ui.$("#empty-title")).toBeNull();
  });

  it("answering moves to the next one without the roster in between", async () => {
    setNarrow(true);
    ui = await bootCockpit({
      rows: [
        waitingRow({ id: "a", label: "alpha", project: "/var/www/bench" }),
        waitingRow({ id: "b", label: "beta", project: "/var/www/teledoctor" }),
      ],
      decision: plain("Ship it?"),
    });

    await waitFor(() => ui.$("#unblock-options .option"), "the first decision");
    expect(ui.$("#unblock-head .eyebrow")!.textContent).toContain("bench · alpha");

    await ui.click(ui.$("#unblock-options .option"));
    await ui.click(ui.$("#unblock-answer"));

    await waitFor(
      () => ui.$("#unblock-head .eyebrow")?.textContent?.includes("teledoctor · beta") ? ui.$("#unblock") : null,
      "the next one",
    );
    expect(pane()).toBe("unblock");

    const answers = ui.sent.filter((s) => s.url.includes("/answer"));
    expect(answers).toHaveLength(1);
    expect(answers[0].url).toContain("/api/sessions/a/answer");
  });

  it("answering the last one lands on the empty screen", async () => {
    setNarrow(true);
    ui = await bootCockpit({
      rows: [waitingRow({ id: "a", label: "alpha", project: "/var/www/bench" })],
      decision: plain("Ship it?"),
    });
    await ui.connect();

    await waitFor(() => ui.$("#unblock-options .option"), "the decision");
    await ui.click(ui.$("#unblock-options .option"));
    await ui.click(ui.$("#unblock-answer"));

    await waitFor(() => ui.$("#empty"), "the empty screen");
    expect(pane()).toBe("empty");
  });

  it("an intake is handed to the ordinary stage rather than answered inline", async () => {
    setNarrow(true);
    ui = await bootCockpit({
      rows: [waitingRow({ id: "a", label: "alpha", project: "/var/www/bench" })],
      decision: intake,
    });

    await waitFor(() => ui.$("#intake"), "the intake sheet");
    expect(pane()).toBe("stage");
    expect(ui.$("#unblock")).toBeNull();
  });

  it("says a send failed and keeps the choice, rather than nothing at all", async () => {
    setNarrow(true);
    ui = await bootCockpit({
      rows: [waitingRow({ id: "a", label: "alpha", project: "/var/www/bench" })],
      decision: plain("Ship it?"),
      answerFails: "reject",
    });

    await waitFor(() => ui.$("#unblock-options .option"), "the decision");
    await ui.click(ui.$("#unblock-options .option"));
    await ui.click(ui.$("#unblock-answer"));

    await waitFor(() => ui.$("#unblock-error"), "the send error");
    expect(ui.$("#unblock-error")!.textContent).toContain("Didn't send");
    // Still on the same one, not moved to the next, choice kept.
    expect(pane()).toBe("unblock");
    expect(ui.$("#unblock-options .option")!.getAttribute("aria-pressed")).toBe("true");
  });

  it("clears the error and moves on once the connection is back", async () => {
    setNarrow(true);
    const fixtures: Parameters<typeof bootCockpit>[0] = {
      rows: [waitingRow({ id: "a", label: "alpha", project: "/var/www/bench" })],
      decision: plain("Ship it?"),
      answerFails: "reject",
    };
    ui = await bootCockpit(fixtures);

    await waitFor(() => ui.$("#unblock-options .option"), "the decision");
    await ui.click(ui.$("#unblock-options .option"));
    await ui.click(ui.$("#unblock-answer"));
    await waitFor(() => ui.$("#unblock-error"), "the send error");

    fixtures.answerFails = undefined;
    await ui.connect();
    await ui.click(ui.$("#unblock-answer"));

    await waitFor(() => ui.$("#empty"), "the empty screen");
    expect(pane()).toBe("empty");
  });

  it("browsing the roster on purpose keeps it in front, even with something waiting", async () => {
    setNarrow(true);
    ui = await bootCockpit({
      rows: [waitingRow({ id: "a", label: "alpha", project: "/var/www/bench" })],
      decision: plain("Ship it?"),
    });

    await waitFor(() => ui.$("#unblock-roster"), "the way to the roster");
    await ui.click(ui.$("#unblock-roster"));

    expect(pane()).toBe("roster");
    expect(ui.$("#unblock")).toBeNull();
  });
});

/**
 * A tab another specialist opened and handed a prompt to holds the developer
 * exactly as hard as an unanswered decision does - but it has no report, so
 * `isWaiting` is false for it and the phone used to say "nothing needs you"
 * while a sub-agent sat there undispatched (#75).
 */
describe("a hand-off waiting on a phone", () => {
  const held = (over: Parameters<typeof row>[0] = {}) => row({
    id: "child", label: "payouts", project: "/var/www/bench",
    status: "awaiting_dispatch", latestReportSeq: null,
    pendingPrompt: "Build what the spec at docs/x.md describes.",
    ...over,
  });

  it("is what the phone lands on, rather than the empty screen", async () => {
    setNarrow(true);
    ui = await bootCockpit({ rows: [held()] });

    await waitFor(() => (ui.$("#dispatch-modal")?.hasAttribute("open") ? ui.$("#dispatch-modal") : null),
      "the dispatch modal");
    // `#empty-title` rather than `#empty`: the thread has an element of that
    // id too, and it is on the page whenever the stage is - see #77.
    expect(ui.$("#empty-title")).toBeNull();
    expect(ui.$("#dispatch-prompt")!.textContent).toBe("Build what the spec at docs/x.md describes.");
  });

  it("goes to the stage, not the unblock screen it has no report for", async () => {
    setNarrow(true);
    ui = await bootCockpit({ rows: [held()] });

    await waitFor(() => (ui.$("#dispatch-modal")?.hasAttribute("open") ? ui.$("#dispatch-modal") : null),
      "the dispatch modal");
    expect(pane()).toBe("stage");
    expect(ui.$("#unblock")).toBeNull();
  });

  it("counts alongside a decision, rather than being invisible next to one", async () => {
    setNarrow(true);
    ui = await bootCockpit({
      rows: [
        waitingRow({ id: "a", label: "alpha", project: "/var/www/bench" }),
        held(),
      ],
      decision: plain("Ship it?"),
    });

    await waitFor(() => ui.$("#unblock-count"), "the count of what is waiting");
    expect(ui.$("#unblock-count")!.textContent).toBe("1 of 2");
  });

  it("once dispatched, leaves the stage rather than a blank unblock screen", async () => {
    setNarrow(true);
    ui = await bootCockpit({ rows: [held()] });

    await waitFor(() => (ui.$("#dispatch-modal")?.hasAttribute("open") ? ui.$("#dispatch-modal") : null),
      "the dispatch modal");

    // What the roster looks like a moment after Dispatch: the tab is running,
    // and nothing is holding the developer any more. Without the fallback in
    // `usePhoneLanding`, `pane` stayed on "unblock" - a screen that draws its
    // own header and nothing else once there is no decision behind it.
    await ui.roster([held({ status: "working", pendingPrompt: null })]);

    await waitFor(() => (pane() === "stage" ? ui.$("#app") : null), "the stage");
    expect(ui.$("#unblock")).toBeNull();
  });
});
