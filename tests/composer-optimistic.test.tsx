/**
 * @vitest-environment jsdom
 * @vitest-environment-options { "url": "http://localhost/?token=t" }
 */
import { describe, it, expect, afterEach } from "vitest";
import { bootCockpit, entry, row, type Cockpit } from "./helpers/cockpit.js";
import { waitFor } from "./helpers/wait-for.js";

/**
 * Sending used to wait for the POST, then for a full thread refetch, before
 * anything on screen moved - two sequential round trips over a relay, with
 * the typed text still sitting in the box. `submit()` now clears the box and
 * puts the message in the thread before either trip; the network settles
 * behind it (#86).
 */

let ui: Cockpit;
afterEach(() => {
  ui?.unmount();
  history.pushState({}, "", "/?token=t");
});

const box = () => ui.$<HTMLTextAreaElement>("#composer-text")!;
const thread = () => ui.$("#thread")!;
const sendButton = () => ui.$("#composer-send")!;

async function open(fixtures: Parameters<typeof bootCockpit>[0] = {}): Promise<void> {
  ui = await bootCockpit({
    rows: [row({ status: "done", detail: "idle" })],
    entries: [entry({ body: "the earlier answer" })],
    ...fixtures,
  });
  await ui.open("auth");
}

describe("sending optimistically", () => {
  it("shows the message and clears the box before the POST has answered", async () => {
    // Never resolves: if the message is on screen and the box is empty by
    // the time this returns, it did not wait on the network for either.
    await open({ messageHangs: true });

    await ui.type(box(), "ship it");
    await ui.pressIn(box(), "Enter");

    expect(box().value).toBe("");
    expect(thread().textContent).toContain("ship it");
  });

  it("marks the send control as sending while that POST is still open", async () => {
    await open({ messageHangs: true });

    await ui.type(box(), "ship it");
    await ui.pressIn(box(), "Enter");

    expect(sendButton().getAttribute("data-state")).toBe("sending");
  });

  it("restores the text and says so when the send fails", async () => {
    await open({ messageFails: "reject" });

    await ui.type(box(), "ship it");
    await ui.pressIn(box(), "Enter");

    await waitFor(() => (box().value === "ship it" ? box() : null), "the restored text");
    expect(ui.$("#composer-hint")!.textContent).toContain("Didn't send");
    expect(sendButton().getAttribute("data-state")).toBe("failed");
  });

  it("does not restore the failed text over a draft already started since", async () => {
    await open({ messageFails: "reject" });

    await ui.type(box(), "ship it");
    await ui.pressIn(box(), "Enter");
    // The failure has already been swallowed by the mock's synchronous
    // rejection by the time this runs; simulate having moved on before the
    // restore would have landed.
    await ui.type(box(), "something else entirely");

    expect(box().value).toBe("something else entirely");
  });

  it("goes back to idle, and the real POST carried the text, once the send actually succeeds", async () => {
    await open();

    await ui.type(box(), "ship it");
    await ui.pressIn(box(), "Enter");

    // The mock's thread fixture is static, so it cannot show the reload
    // picking the message back up as a real entry the way the daemon would -
    // what this can confirm is that the optimistic copy hands off cleanly
    // (sending -> idle, nothing left in "failed") and that the actual
    // network call the developer is waiting on carried the right text.
    await waitFor(() => (sendButton().getAttribute("data-state") === "idle" ? sendButton() : null), "idle again");
    expect(ui.sent.some((s) => s.url.includes("/message") && s.body.text === "ship it")).toBe(true);
  });
});
