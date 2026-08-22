/**
 * @vitest-environment jsdom
 * @vitest-environment-options { "url": "http://localhost/?token=t" }
 */
import { describe, it, expect, afterEach } from "vitest";
import { bootCockpit, entry, row, type Cockpit } from "./helpers/cockpit.js";

/**
 * The composer was an `<input>`, which cannot hold a newline at all — so a
 * brief with two paragraphs in it reached the specialist as one long line.
 * Enter still has to send, or the rhythm of the whole cockpit changes.
 */

let ui: Cockpit;
afterEach(() => {
  ui?.unmount();
  history.pushState({}, "", "/?token=t");
});

const box = () => ui.$<HTMLTextAreaElement>("#composer-text")!;
const sent = () => ui.sent.filter((s) => s.url.endsWith("/message"));

async function open(): Promise<void> {
  ui = await bootCockpit({ rows: [row({ status: "done", detail: "idle" })], entries: [entry()] });
  await ui.open("auth");
}

describe("typing more than one line", () => {
  it("is a box that can hold a newline at all", async () => {
    await open();
    expect(box().tagName).toBe("TEXTAREA");
  });

  it("sends on Enter", async () => {
    await open();
    await ui.type(box(), "do the thing");
    await ui.pressIn(box(), "Enter");

    expect(sent()).toHaveLength(1);
    expect(sent()[0].body.text).toBe("do the thing");
  });

  it("does not send on Shift+Enter — that is the newline", async () => {
    await open();
    await ui.type(box(), "first line");
    await ui.pressIn(box(), "Enter", { shiftKey: true });

    expect(sent()).toHaveLength(0);
    // And what was typed is still there to keep typing into.
    expect(box().value).toBe("first line");
  });

  it("empties the box once the message has gone", async () => {
    await open();
    await ui.type(box(), "do the thing");
    await ui.pressIn(box(), "Enter");

    expect(box().value).toBe("");
  });

  it("refuses an empty message, as it always did", async () => {
    await open();
    await ui.pressIn(box(), "Enter");

    expect(sent()).toHaveLength(0);
  });
});
