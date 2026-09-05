/**
 * @vitest-environment jsdom
 * @vitest-environment-options { "url": "http://localhost/?token=t" }
 */
import { describe, it, expect, afterEach } from "vitest";
import type { Decision } from "../src/shared/types.js";
import { bootCockpit, row, type Cockpit } from "./helpers/cockpit.js";
import { waitFor } from "./helpers/wait-for.js";

/**
 * On a phone the front door is the roster, exactly as it is above the
 * breakpoint (#83) - something waiting is shown there, not navigated to on
 * arrival. jsdom has no real viewport, so `useNarrowViewport` is fed a fake
 * `matchMedia` here rather than a resize. What these hold in place: nothing
 * is ever selected on open, tapping a waiting row opens its decision as a
 * sheet *over* the roster rather than replacing the screen with it (#90),
 * and answering one still advances straight to the next without a detour
 * back through the roster.
 *
 * `#unblock` is a `<dialog>` now, always mounted - `bootCockpit`'s
 * `polyfillDialogs()` gives jsdom `showModal`/`close`, so `hasAttribute
 * ("open")` is what tells a test the sheet is actually showing, the same
 * way the dispatch modal tests below already read `#dispatch-modal`.
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
const sheetOpen = () => ui.$("#unblock")?.hasAttribute("open") ?? false;

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
    expect(sheetOpen()).toBe(false);
  });

  it("opens on the roster, whatever is waiting - nothing is selected on its own", async () => {
    setNarrow(true);
    ui = await bootCockpit({
      rows: [waitingRow({ id: "a", label: "alpha", project: "/var/www/bench" })],
      decision: plain("Ship it?"),
    });

    expect(pane()).toBe("roster");
    expect(sheetOpen()).toBe(false);
    // Shown, not navigated to: the row itself already carries the tinted
    // rail and background `styles.css` gives `data-waiting="true"`.
    expect(ui.$('.row[data-waiting="true"]')).not.toBeNull();
  });

  it("opens on the roster the same way whether the socket has settled or not", async () => {
    // No `ui.connect()`: the socket has not so much as opened. Before #83
    // this - and a settled-but-empty roster - were the two states that could
    // land on PhoneEmpty's "Nothing needs you." Landing never runs at all
    // now, so neither can say anything before it is asked.
    setNarrow(true);
    ui = await bootCockpit({ rows: [] });

    expect(pane()).toBe("roster");
    expect(sheetOpen()).toBe(false);
  });

  it("tapping a waiting row opens its decision as a sheet, with the roster still mounted behind it", async () => {
    setNarrow(true);
    ui = await bootCockpit({
      rows: [waitingRow({ id: "a", label: "alpha", project: "/var/www/bench" })],
      decision: plain("Ship it?"),
    });

    await ui.open("alpha");

    await waitFor(() => (sheetOpen() ? ui.$("#unblock") : null), "the decision sheet");
    expect(ui.$("#unblock-title")!.textContent).toBe("Ship it?");
    // The roster is not navigated away from to show this - #90's whole
    // point - so the pane underneath is still "roster" and its rows are
    // still in the document, not torn down.
    expect(pane()).toBe("roster");
    expect(ui.$(".row")).not.toBeNull();
  });

  it("the report and the options are both there, unanswered", async () => {
    setNarrow(true);
    ui = await bootCockpit({
      rows: [waitingRow({ id: "a", label: "alpha", project: "/var/www/bench" })],
      decision: plain("Ship it?"),
    });
    await ui.open("alpha");

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
    await ui.open("alpha");

    await waitFor(() => (sheetOpen() ? ui.$("#unblock") : null), "the decision sheet");
    // The header is real either way - what changes is everything under it.
    expect(ui.$("#unblock-head .eyebrow")).not.toBeNull();
    expect(ui.$("#unblock-title")).toBeNull();
    expect(ui.$(".unblock-title-skeleton")).not.toBeNull();
    expect(ui.$(".unblock-options-skeleton")).not.toBeNull();
  });

  it("nothing waiting is just an ordinary roster - there is no separate screen for it", async () => {
    setNarrow(true);
    ui = await bootCockpit({ rows: [row({ status: "working", latestReportSeq: null })] });
    await ui.connect();

    expect(pane()).toBe("roster");
    expect(ui.$('.row[data-waiting="true"]')).toBeNull();
  });

  it("answering moves to the next one, re-populating the same sheet rather than closing and reopening", async () => {
    setNarrow(true);
    ui = await bootCockpit({
      rows: [
        waitingRow({ id: "a", label: "alpha", project: "/var/www/bench" }),
        waitingRow({ id: "b", label: "beta", project: "/var/www/teledoctor" }),
      ],
      decision: plain("Ship it?"),
    });
    await ui.open("alpha");

    await waitFor(() => ui.$("#unblock-options .option"), "the first decision");
    expect(ui.$("#unblock-head .eyebrow")!.textContent).toContain("bench · alpha");
    expect(sheetOpen()).toBe(true);

    await ui.click(ui.$("#unblock-options .option"));
    await ui.click(ui.$("#unblock-answer"));

    await waitFor(
      () => ui.$("#unblock-head .eyebrow")?.textContent?.includes("teledoctor · beta") ? ui.$("#unblock") : null,
      "the next one",
    );
    // Never closed in between - the same dialog stayed open and swapped
    // what it shows, which is what "re-populating" means here.
    expect(sheetOpen()).toBe(true);
    expect(pane()).toBe("roster");

    const answers = ui.sent.filter((s) => s.url.includes("/answer"));
    expect(answers).toHaveLength(1);
    expect(answers[0].url).toContain("/api/sessions/a/answer");
  });

  it("answering the last one closes the sheet and leaves the roster in front", async () => {
    setNarrow(true);
    ui = await bootCockpit({
      rows: [waitingRow({ id: "a", label: "alpha", project: "/var/www/bench" })],
      decision: plain("Ship it?"),
    });
    await ui.connect();
    await ui.open("alpha");

    await waitFor(() => ui.$("#unblock-options .option"), "the decision");
    await ui.click(ui.$("#unblock-options .option"));
    await ui.click(ui.$("#unblock-answer"));

    await waitFor(() => (!sheetOpen() ? ui.$("#app") : null), "the sheet to close");
    expect(pane()).toBe("roster");
  });

  it("dismissing keeps the choice and typed text for the same decision, in the same session", async () => {
    setNarrow(true);
    ui = await bootCockpit({
      rows: [waitingRow({ id: "a", label: "alpha", project: "/var/www/bench" })],
      decision: plain("Ship it?"),
    });
    await ui.open("alpha");

    await waitFor(() => ui.$("#unblock-options .option"), "the decision");
    await ui.click(ui.$("#unblock-options .option"));
    await ui.type(ui.$("#unblock-text"), "a note besides");

    // Dismiss without answering - nothing sent.
    await ui.click(ui.$("#unblock-roster"));
    expect(sheetOpen()).toBe(false);
    expect(ui.sent.filter((s) => s.url.includes("/answer"))).toHaveLength(0);

    // Reopen the same row's decision in the same session.
    await ui.open("alpha");
    await waitFor(() => (sheetOpen() ? ui.$("#unblock-options .option") : null), "the reopened decision");
    expect(ui.$("#unblock-options .option")!.getAttribute("aria-pressed")).toBe("true");
    expect(ui.$<HTMLInputElement>("#unblock-text")!.value).toBe("a note besides");
  });

  it("an intake is handed to the ordinary stage rather than answered inline", async () => {
    setNarrow(true);
    ui = await bootCockpit({
      rows: [waitingRow({ id: "a", label: "alpha", project: "/var/www/bench" })],
      decision: intake,
    });
    await ui.open("alpha");

    await waitFor(() => ui.$("#intake"), "the intake sheet");
    expect(pane()).toBe("stage");
    expect(sheetOpen()).toBe(false);
  });

  it("says a send failed and keeps the choice, rather than nothing at all", async () => {
    setNarrow(true);
    ui = await bootCockpit({
      rows: [waitingRow({ id: "a", label: "alpha", project: "/var/www/bench" })],
      decision: plain("Ship it?"),
      answerFails: "reject",
    });
    await ui.open("alpha");

    await waitFor(() => ui.$("#unblock-options .option"), "the decision");
    await ui.click(ui.$("#unblock-options .option"));
    await ui.click(ui.$("#unblock-answer"));

    await waitFor(() => ui.$("#unblock-error"), "the send error");
    expect(ui.$("#unblock-error")!.textContent).toContain("Didn't send");
    // Still on the same one, not moved to the next, choice kept.
    expect(sheetOpen()).toBe(true);
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
    await ui.open("alpha");

    await waitFor(() => ui.$("#unblock-options .option"), "the decision");
    await ui.click(ui.$("#unblock-options .option"));
    await ui.click(ui.$("#unblock-answer"));
    await waitFor(() => ui.$("#unblock-error"), "the send error");

    fixtures.answerFails = undefined;
    await ui.click(ui.$("#unblock-answer"));

    await waitFor(() => (!sheetOpen() ? ui.$("#app") : null), "the sheet to close");
    expect(pane()).toBe("roster");
  });

  it("browsing the roster on purpose closes the sheet, even with something waiting", async () => {
    setNarrow(true);
    ui = await bootCockpit({
      rows: [waitingRow({ id: "a", label: "alpha", project: "/var/www/bench" })],
      decision: plain("Ship it?"),
    });
    await ui.open("alpha");

    await waitFor(() => ui.$("#unblock-roster"), "the way to the roster");
    await ui.click(ui.$("#unblock-roster"));

    expect(pane()).toBe("roster");
    expect(sheetOpen()).toBe(false);
  });
});

/**
 * A tab another specialist opened and handed a prompt to holds the developer
 * exactly as hard as an unanswered decision does - but it has no report, so
 * `isWaiting` is false for it and the phone used to say "nothing needs you"
 * while a sub-agent sat there undispatched (#75). It is shown on the roster
 * the same way a decision is (#83) rather than either navigated to.
 */
describe("a hand-off waiting on a phone", () => {
  const held = (over: Parameters<typeof row>[0] = {}) => row({
    id: "child", label: "payouts", project: "/var/www/bench",
    status: "awaiting_dispatch", latestReportSeq: null,
    pendingPrompt: "Build what the spec at docs/x.md describes.",
    ...over,
  });

  it("shows on the roster rather than opening the dispatch modal on its own", async () => {
    setNarrow(true);
    ui = await bootCockpit({ rows: [held()] });

    expect(pane()).toBe("roster");
    expect(ui.$("#dispatch-modal")?.hasAttribute("open")).toBeFalsy();
    expect(ui.$('.row[data-waiting="true"]')).not.toBeNull();
  });

  it("tapping it goes to the stage and opens the dispatch modal, not the decision sheet it has no report for", async () => {
    setNarrow(true);
    ui = await bootCockpit({ rows: [held()] });
    await ui.open("payouts");

    await waitFor(() => (ui.$("#dispatch-modal")?.hasAttribute("open") ? ui.$("#dispatch-modal") : null),
      "the dispatch modal");
    expect(pane()).toBe("stage");
    expect(sheetOpen()).toBe(false);
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
    await ui.open("alpha");

    await waitFor(() => ui.$("#unblock-count"), "the count of what is waiting");
    expect(ui.$("#unblock-count")!.textContent).toBe("1 of 2");
  });

  it("once dispatched, leaves the stage rather than a blank sheet", async () => {
    setNarrow(true);
    ui = await bootCockpit({ rows: [held()] });
    await ui.open("payouts");

    await waitFor(() => (ui.$("#dispatch-modal")?.hasAttribute("open") ? ui.$("#dispatch-modal") : null),
      "the dispatch modal");

    // What the roster looks like a moment after Dispatch: the tab is running,
    // and nothing is holding the developer any more.
    await ui.roster([held({ status: "working", pendingPrompt: null })]);

    await waitFor(() => (pane() === "stage" ? ui.$("#app") : null), "the stage");
    expect(sheetOpen()).toBe(false);
  });
});

/**
 * #94. The sheet's exit gesture drives an inline `transform` on the dialog,
 * and `DecisionSheet` stays mounted across open and close - so it is the
 * same element every time. A transform left behind by one dismissal opened
 * the next decision a full sheet-height below the viewport, where the
 * `::backdrop` still drew but the sheet did not: a dimmed roster with
 * nothing on it, and it stayed that way until a reload.
 *
 * jsdom cannot see that geometrically - it has no layout - but it does not
 * need to. The bug is inline-style bookkeeping, and that is what this holds:
 * whatever a gesture left on the element, opening starts clean.
 */
describe("the decision sheet reopening after a gesture", () => {
  it("opens with no transform left over from the last dismissal", async () => {
    setNarrow(true);
    ui = await bootCockpit({
      rows: [waitingRow({ id: "a", label: "alpha", project: "/var/www/bench" })],
      decision: plain("Ship it?"),
    });

    await ui.open("alpha");
    const dialog = await waitFor(() => (sheetOpen() ? ui.$("#unblock") : null), "the sheet") as HTMLElement;

    // What the swipe-dismiss leaves on the element while its exit plays, and
    // what an interrupted spring-back can leave on it for good.
    dialog.style.transition = "transform 340ms";
    dialog.style.transform = "translateY(796px)";

    await ui.click(ui.$("#unblock-roster"));
    await waitFor(() => (sheetOpen() ? null : dialog), "the sheet to close");

    await ui.open("alpha");
    await waitFor(() => (sheetOpen() ? dialog : null), "the sheet to reopen");

    expect(dialog.style.transform).toBe("");
    expect(dialog.style.transition).toBe("");
  });
});
