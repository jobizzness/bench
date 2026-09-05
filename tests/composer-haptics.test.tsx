/**
 * @vitest-environment jsdom
 * @vitest-environment-options { "url": "http://localhost/?token=t" }
 */
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import type { Decision } from "../src/shared/types.js";
import { bootCockpit, entry, row, type Cockpit } from "./helpers/cockpit.js";
import { waitFor } from "./helpers/wait-for.js";

/**
 * Sending used to be the one decisive tap in this app that stayed silent -
 * choosing a decision's option buzzed (DecisionOptions.tsx), dismissing the
 * sheet buzzed (#93), and pressing send did not (#95). jsdom has neither
 * layout nor a real `navigator.vibrate` (see the report on #91 and #95), so
 * this stubs the API and asserts the call sites rather than anything felt.
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
  // @ts-expect-error - test-only teardown of a property this suite defined.
  delete navigator.vibrate;
});

const box = () => ui.$<HTMLTextAreaElement>("#composer-text")!;

describe("sending a plain message buzzes, matching the sheet's answer", () => {
  async function open(fixtures: Parameters<typeof bootCockpit>[0] = {}): Promise<void> {
    ui = await bootCockpit({
      rows: [row({ status: "done", detail: "idle" })],
      entries: [entry()],
      ...fixtures,
    });
    await ui.open("auth");
  }

  it("buzzes once when the message is sent", async () => {
    await open();
    await ui.type(box(), "first");
    await ui.pressIn(box(), "Enter");

    expect(vibrate).toHaveBeenCalledTimes(1);
    expect(vibrate).toHaveBeenLastCalledWith(12);
  });

  it("buzzes again on a second send, not just the first (#94's lesson)", async () => {
    await open();
    await ui.type(box(), "first");
    await ui.pressIn(box(), "Enter");
    await ui.type(box(), "second");
    await ui.pressIn(box(), "Enter");

    expect(vibrate).toHaveBeenCalledTimes(2);
  });

  it("buzzes a distinct pattern when a send fails, not the same tap as a success", async () => {
    await open({ messageFails: "reject" });
    await ui.type(box(), "ship it");
    await ui.pressIn(box(), "Enter");
    await waitFor(() => (box().value === "ship it" ? box() : null), "the restored text");

    // Two calls, not one: `tap()` still fires at the moment the send is
    // initiated (the gesture, acknowledged immediately, same as every
    // other send) and `tapFailed()` fires in addition once it comes back
    // bad - never instead of it, and never the same shape as it.
    expect(vibrate).toHaveBeenCalledTimes(2);
    expect(vibrate.mock.calls[0][0]).toBe(12);
    expect(Array.isArray(vibrate.mock.calls[1][0])).toBe(true);
  });

  it("keeps failing distinctly on the second attempt too", async () => {
    await open({ messageFails: "reject" });
    await ui.type(box(), "one");
    await ui.pressIn(box(), "Enter");
    await waitFor(() => (box().value === "one" ? box() : null), "the first restore");
    await ui.type(box(), "two");
    await ui.pressIn(box(), "Enter");
    await waitFor(() => (box().value === "two" ? box() : null), "the second restore");

    expect(vibrate).toHaveBeenCalledTimes(4);
    expect(Array.isArray(vibrate.mock.calls[1][0])).toBe(true);
    expect(Array.isArray(vibrate.mock.calls[3][0])).toBe(true);
  });
});

describe("answering a decision from the composer buzzes the same way", () => {
  const spec = (): Decision => ({
    kind: "spec_approval", title: "t", summary: "s", options: [], questions: [], allowFreeText: true,
  });

  async function open(): Promise<void> {
    ui = await bootCockpit({
      rows: [row({ label: "reset", latestReportSeq: 1, answeredReportSeq: null })],
      decision: spec(),
    });
    await ui.open("reset");
    await waitFor(() => ui.$(".option"), "the decision");
  }

  it("buzzes once on send, on top of the option's own tap", async () => {
    await open();
    await ui.click(ui.$$(".option")[0]); // choosing an option already taps (DecisionOptions.tsx)
    const afterChoice = vibrate.mock.calls.length;

    await ui.pressIn(ui.$("#composer-text"), "Enter");

    expect(vibrate.mock.calls.length).toBe(afterChoice + 1);
    expect(vibrate).toHaveBeenLastCalledWith(12);
  });

  it("buzzes distinctly when the answer fails to send", async () => {
    // A bad status, not "reject": the composer's decision-answer path only
    // has a branch for `!res.ok` (App.tsx's `submit`), not a `catch` for a
    // rejected fetch the way the plain-message path and the sheet's own
    // `send` both do - see the note filed on that gap. "reject" here would
    // throw unhandled rather than exercise the haptics this test is about.
    ui = await bootCockpit({
      rows: [row({ label: "reset", latestReportSeq: 1, answeredReportSeq: null })],
      decision: spec(),
      answerFails: 502,
    });
    await ui.open("reset");
    await waitFor(() => ui.$(".option"), "the decision");

    await ui.click(ui.$$(".option")[0]);
    vibrate.mockClear();
    await ui.pressIn(ui.$("#composer-text"), "Enter");

    expect(vibrate).toHaveBeenCalledTimes(2); // the send tap, then the failure
    expect(vibrate.mock.calls[0][0]).toBe(12);
    expect(Array.isArray(vibrate.mock.calls[1][0])).toBe(true);
  });
});

describe("attaching an image buzzes once", () => {
  let originalCreateObjectURL: any;
  let originalRevokeObjectURL: any;
  let originalFileReader: any;
  let originalImage: any;

  beforeEach(() => {
    originalCreateObjectURL = URL.createObjectURL;
    originalRevokeObjectURL = URL.revokeObjectURL;
    originalFileReader = global.FileReader;
    originalImage = global.Image;

    URL.createObjectURL = () => "blob:test";
    URL.revokeObjectURL = () => {};
    global.FileReader = class {
      onload: () => void = () => {};
      result = "data:image/png;base64,TEST_DATA";
      readAsDataURL() { setTimeout(() => this.onload(), 10); }
    } as any;
    global.Image = class {
      onload: () => void = () => {};
      width = 100;
      height = 100;
      set src(_val: string) { setTimeout(() => this.onload(), 10); }
    } as any;
  });

  afterEach(() => {
    URL.createObjectURL = originalCreateObjectURL;
    URL.revokeObjectURL = originalRevokeObjectURL;
    global.FileReader = originalFileReader;
    global.Image = originalImage;
  });

  it("buzzes once a dropped image is actually attached", async () => {
    ui = await bootCockpit({ rows: [row({ status: "done", detail: "idle" })], entries: [entry()] });
    await ui.open("auth");

    const file = new File(["test data"], "test.png", { type: "image/png" });
    const dropEvent = new Event("drop", { bubbles: true }) as any;
    dropEvent.dataTransfer = { files: [file] };
    ui.$("#composer-form")!.dispatchEvent(dropEvent);
    await new Promise((r) => setTimeout(r, 50));

    expect(ui.$(".composer-attachment")).not.toBeNull();
    expect(vibrate).toHaveBeenCalledTimes(1);
    expect(vibrate).toHaveBeenLastCalledWith(12);
  });

  it("does not buzz for a rejected file", async () => {
    ui = await bootCockpit({ rows: [row({ status: "done", detail: "idle" })], entries: [entry()] });
    await ui.open("auth");

    const file = new File(["test data"], "test.pdf", { type: "application/pdf" });
    const dropEvent = new Event("drop", { bubbles: true }) as any;
    dropEvent.dataTransfer = { files: [file] };
    ui.$("#composer-form")!.dispatchEvent(dropEvent);
    await new Promise((r) => setTimeout(r, 50));

    expect(ui.$("#composer-hint")?.textContent).toContain("application/pdf");
    expect(vibrate).not.toHaveBeenCalled();
  });
});

describe("what does not buzz", () => {
  it("a specialist starting to want you does not buzz (#95 - that is a notification, not this ticket)", async () => {
    ui = await bootCockpit({ rows: [row({ id: "s1", label: "auth", status: "working" })] });
    vibrate.mockClear();

    await ui.roster([row({ id: "s1", label: "auth", status: "awaiting_decision", latestReportSeq: 1, answeredReportSeq: null })]);

    expect(vibrate).not.toHaveBeenCalled();
  });
});
