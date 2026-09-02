/**
 * @vitest-environment jsdom
 * @vitest-environment-options { "url": "http://localhost/?token=t" }
 */
import { describe, it, expect, afterEach, beforeEach } from "vitest";
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
 * A soft keyboard draws a return key, not a send key, and nothing on the
 * screen said Enter would submit - so the phone had a box you could type into
 * and no way to post it (#61). The button is drawn at every width and hidden
 * again above the breakpoint by CSS, which jsdom does not apply; these assert
 * the markup and the wiring, and the width itself is a stylesheet question.
 */
describe("the send button", () => {
  const sendButton = () => ui.$<HTMLButtonElement>("#composer-send")!;

  it("is there for an ordinary message", async () => {
    await open();
    expect(sendButton()).not.toBeNull();
    expect(sendButton().className).toBe("phone-only");
  });

  it("is disabled with nothing to send, and enabled once there is", async () => {
    await open();
    expect(sendButton().disabled).toBe(true);

    await ui.type(box(), "do the thing");
    expect(sendButton().disabled).toBe(false);
  });

  it("stays disabled for whitespace alone", async () => {
    await open();
    await ui.type(box(), "   ");
    expect(sendButton().disabled).toBe(true);
  });

  it("sends exactly what Enter sends", async () => {
    await open();
    await ui.type(box(), "do the thing");
    await ui.click(sendButton());

    expect(sent()).toHaveLength(1);
    expect(sent()[0].body.text).toBe("do the thing");
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

  it("names the router, not a model, on an auto tab that has not answered yet", async () => {
    ui = await bootCockpit({ rows: [row({ model: "openrouter/auto", answeredBy: null })], entries: [entry()] });
    await ui.open("auth");
    expect(ui.$("#composer-model")!.textContent).toBe("auto");
  });

  it("names what actually answered, tagged as auto, once an auto tab has taken a turn", async () => {
    ui = await bootCockpit({
      rows: [row({ model: "openrouter/auto", answeredBy: ["z-ai/glm-5.2"] })],
      entries: [entry()],
    });
    await ui.open("auth");
    expect(ui.$("#composer-model")!.textContent).toBe("glm-5.2 <auto>");
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

describe("composer attachments", () => {
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

    // Mock FileReader to return a fake base64 string
    global.FileReader = class {
      onload: () => void = () => {};
      result = "data:image/png;base64,TEST_DATA";
      readAsDataURL() {
        setTimeout(() => this.onload(), 10);
      }
    } as any;

    // Mock Image to trigger onload asynchronously
    global.Image = class {
      onload: () => void = () => {};
      width = 100;
      height = 100;
      set src(val: string) {
        setTimeout(() => this.onload(), 10);
      }
    } as any;
  });

  afterEach(() => {
    URL.createObjectURL = originalCreateObjectURL;
    URL.revokeObjectURL = originalRevokeObjectURL;
    global.FileReader = originalFileReader;
    global.Image = originalImage;
  });

  it("adds an image attachment on drag and drop", async () => {
    await open();
    const file = new File(["test data"], "test.png", { type: "image/png" });

    // Mock dataTransfer with the file
    const dropEvent = new Event("drop", { bubbles: true }) as any;
    dropEvent.dataTransfer = {
      files: [file],
    };

    ui.$("#composer-form")!.dispatchEvent(dropEvent);

    // Wait for the async processImage and FileReader
    await new Promise((r) => setTimeout(r, 50));

    expect(ui.$(".composer-attachments")).not.toBeNull();
    expect(ui.$(".composer-attachment img")?.getAttribute("src")).toContain("TEST_DATA");
  });

  it("removes an image attachment when × is clicked", async () => {
    await open();
    const file = new File(["test data"], "test.png", { type: "image/png" });
    const dropEvent = new Event("drop", { bubbles: true }) as any;
    dropEvent.dataTransfer = { files: [file] };

    ui.$("#composer-form")!.dispatchEvent(dropEvent);
    await new Promise((r) => setTimeout(r, 50));

    expect(ui.$(".composer-attachment")).not.toBeNull();

    // Click remove button
    await ui.click(ui.$(".composer-attachment .remove"));
    expect(ui.$(".composer-attachment")).toBeNull();
  });

  it("shows an error when adding a non-image file", async () => {
    await open();
    const file = new File(["test data"], "test.pdf", { type: "application/pdf" });
    const dropEvent = new Event("drop", { bubbles: true }) as any;
    dropEvent.dataTransfer = { files: [file] };

    ui.$("#composer-form")!.dispatchEvent(dropEvent);
    await new Promise((r) => setTimeout(r, 50));

    expect(ui.$(".composer-attachments")).toBeNull();
    expect(ui.$("#composer-hint")?.textContent).toContain("application/pdf");
  });
});

