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

/**
 * Which model this specialist runs on, at the moment you are deciding to send
 * it work.
 *
 * It used to be visible only as a badge in the header and settable only when
 * the specialist was made - so the model was a thing you chose once, in a
 * dialog, and then could not see from the place you actually work.
 */
describe("the model, from the composer", () => {
  it("says what the selected specialist is running on", async () => {
    ui = await bootCockpit({ rows: [row({ model: "haiku" })], entries: [entry()] });
    await ui.open("auth");
    expect(ui.$("#composer-model")!.textContent).toBe("Haiku 4.5");
  });

  it("names an OpenRouter model without repeating its vendor", async () => {
    // The vendor is dropped because it is already the heading the model sits
    // under in the picker; what stays is the model itself.
    ui = await bootCockpit({ rows: [row({ model: "google/gemini-3.7-flash" })], entries: [entry()] });
    await ui.open("auth");
    expect(ui.$("#composer-model")!.textContent).toBe("gemini-3.7-flash");
  });

  it("opens the model modal when it is pressed", async () => {
    ui = await bootCockpit({ rows: [row({ model: "opus" })], entries: [entry()] });
    await ui.open("auth");
    // The element is always mounted; what changes is whether it is showing.
    expect(ui.$<HTMLDialogElement>("#model-dialog")!.open).toBe(false);

    await ui.click(ui.$("#composer-model"));
    expect(ui.$<HTMLDialogElement>("#model-dialog")!.open).toBe(true);
  });

  it("is not there when no specialist is selected", async () => {
    // The composer is disabled then too. A model control for nothing is a
    // control that opens onto nothing.
    ui = await bootCockpit({ rows: [] });
    expect(ui.$("#composer-model")).toBe(null);
  });

  it("follows the specialist you switch to", async () => {
    ui = await bootCockpit({ rows: [
      row({ id: "s1", label: "auth", model: "opus" }),
      row({ id: "s2", label: "billing", model: "sonnet" }),
    ], entries: [entry()] });

    await ui.open("auth");
    expect(ui.$("#composer-model")!.textContent).toBe("Opus 5");

    await ui.open("billing");
    expect(ui.$("#composer-model")!.textContent).toBe("Sonnet 5");
  });

  it("says a model this cockpit has never heard of as itself", async () => {
    // The CLI takes full model names, and a specialist made with one is still
    // a specialist. Saying nothing would be a lie about the box you are
    // typing into.
    ui = await bootCockpit({ rows: [row({ model: "claude-fable-5" })], entries: [entry()] });
    await ui.open("auth");
    expect(ui.$("#composer-model")!.textContent).toBe("claude-fable-5");
  });

  it("is not there for a row from a daemon that predates the field", async () => {
    const { model, ...older } = row();
    ui = await bootCockpit({ rows: [older as ReturnType<typeof row>], entries: [entry()] });
    await ui.open("auth");
    expect(ui.$("#composer-model")).toBe(null);
  });
});
