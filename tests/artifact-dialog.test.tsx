/**
 * @vitest-environment jsdom
 * @vitest-environment-options { "url": "http://localhost/?token=t%2Bok" }
 */
import { describe, it, expect, afterEach } from "vitest";
import { bootCockpit, entry, row, type Cockpit } from "./helpers/cockpit.js";

/**
 * A report is a page: clicking it opens one. The sandbox on the frame is the
 * one thing here a mistake would actually matter in, so it is asserted
 * literally rather than through what it lets through.
 */

const DONE = row({ label: "reset", status: "done", latestReportSeq: null });

const ENTRIES = [
  entry({ seq: 1, kind: "user", body: "add password reset" }),
  entry({ seq: 2, kind: "report", body: "Token expiry strategy", reportSeq: 4 }),
  entry({ seq: 3, kind: "reply", body: "Where the mailer lives", replySeq: 5 }),
];

let ui: Cockpit;
afterEach(() => ui?.unmount());

async function open(): Promise<Cockpit> {
  ui = await bootCockpit({ rows: [DONE], entries: ENTRIES, decision: null });
  await ui.open("reset");
  return ui;
}

const cards = () => ui.$$("#thread .card");
const dialog = () => ui.$<HTMLDialogElement>("#artifact-dialog")!;
const frame = () => ui.$<HTMLIFrameElement>("#artifact-frame");
const doorOf = (index: number) => cards()[index].querySelector<HTMLButtonElement>("button.card-open");

describe("artifact cards in the thread", () => {
  it("gives a report a door and no inline frame", async () => {
    await open();
    const [report] = cards();
    expect(report.querySelector(".kind")!.textContent).toBe("report");
    expect(report.querySelector(".title")!.textContent).toBe("Token expiry strategy");
    expect(report.querySelector("button.card-open")).not.toBeNull();
    expect(report.querySelector("iframe")).toBeNull();
  });

  it("still previews a reply, because a reply is the answer to something you asked", async () => {
    await open();
    const preview = cards()[1].querySelector("iframe")!;
    expect(cards()[1].querySelector(".kind")!.textContent).toBe("answer");
    expect(preview.getAttribute("src")).toBe("/r/s1/5/reply.html?token=t%2Bok");
  });

  it("sandboxes a preview to a same-origin document and nothing else", async () => {
    await open();
    // No allow-scripts, ever: a report is HTML a specialist wrote.
    expect(cards()[1].querySelector("iframe")!.getAttribute("sandbox")).toBe("allow-same-origin");
  });

  it("starts with the dialog closed and nothing loaded in it", async () => {
    await open();
    expect(dialog().open).toBe(false);
    expect(frame()).toBeNull();
  });

  it("renders an ordinary message as a bubble rather than a card", async () => {
    await open();
    expect(ui.$(".entry.user .bubble")!.textContent).toContain("add password reset");
  });
});

describe("opening one", () => {
  it("opens the report in the dialog with its own title", async () => {
    await open();
    await ui.click(doorOf(0));

    expect(dialog().open).toBe(true);
    expect(ui.$("#artifact-kind")!.textContent).toBe("report");
    expect(ui.$("#artifact-title")!.textContent).toBe("Token expiry strategy");
    expect(frame()!.getAttribute("src")).toBe("/r/s1/4/report.html?token=t%2Bok");
  });

  it("sandboxes the dialog's frame the same way", async () => {
    await open();
    await ui.click(doorOf(0));
    expect(frame()!.getAttribute("sandbox")).toBe("allow-same-origin");
  });

  it("offers the same page in a real tab", async () => {
    await open();
    await ui.click(doorOf(0));

    // The token is url-encoded rather than pasted in raw, or a "+" in it
    // silently becomes a space and the tab 401s.
    const tab = ui.$<HTMLAnchorElement>("#artifact-tab")!;
    expect(tab.getAttribute("href")).toBe("/r/s1/4/report.html?token=t%2Bok");
    expect(tab.target).toBe("_blank");
  });

  it("tears the frame down on close so a hidden page stops rendering", async () => {
    await open();
    await ui.click(doorOf(0));
    await ui.click(ui.$("#artifact-close"));

    expect(dialog().open).toBe(false);
    expect(frame()).toBeNull();
  });

  it("closes on the backdrop but not on a click inside the dialog", async () => {
    await open();
    await ui.click(doorOf(0));

    await ui.click(ui.$("#artifact-title"));
    expect(dialog().open).toBe(true);

    await ui.click(dialog());
    expect(dialog().open).toBe(false);
  });

  it("opens a reply from the same door, at its own sequence", async () => {
    await open();
    await ui.click(doorOf(1));

    expect(ui.$("#artifact-kind")!.textContent).toBe("answer");
    expect(frame()!.getAttribute("src")).toBe("/r/s1/5/reply.html?token=t%2Bok");
  });

  it("clears the frame when Esc closes it, not only the button", async () => {
    await open();
    await ui.click(doorOf(0));
    expect(frame()).not.toBeNull();

    // What Esc does natively: the dialog closes and fires `close`. Nothing
    // in the app is called here, so the teardown has to hang off that event.
    await ui.run(() => dialog().close());
    expect(dialog().open).toBe(false);
    expect(frame()).toBeNull();
  });
});
