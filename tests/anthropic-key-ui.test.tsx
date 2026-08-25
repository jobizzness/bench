/**
 * @vitest-environment jsdom
 * @vitest-environment-options { "url": "http://localhost/?token=t" }
 */
import { describe, it, expect, afterEach } from "vitest";
import { bootCockpit, row, type Cockpit, type Fixtures } from "./helpers/cockpit.js";
import { waitFor } from "./helpers/wait-for.js";

/**
 * A key typed here goes to the daemon and does not come back. These tests are
 * what stops that becoming a field that quietly shows a secret to whoever has
 * the cockpit open.
 */

const KEY = "sk-ant-api03-typed-into-the-cockpit-4f2a";

let ui: Cockpit;
afterEach(() => {
  ui?.unmount();
  history.pushState({}, "", "/?token=t");
});

const sentKey = () => ui.sent.find((s) => s.url.includes("/anthropic-key"));
const state = () => ui.$("#s-key-state")!.textContent ?? "";

async function open(over: Partial<Fixtures> = {}): Promise<void> {
  ui = await bootCockpit({ rows: [row()], ...over });
  await ui.click(ui.$("#open-settings"));
  await waitFor(() => ui.$("#s-key-input"), "the key field");
}

describe("the API key field", () => {
  it("says the machine's own login is being used when no key is set", async () => {
    await open();

    expect(state()).toContain("login");
    expect(ui.$<HTMLInputElement>("#s-key-input")!.value).toBe("");
  });

  it("shows which key is set without showing the key", async () => {
    await open({ apiKey: { present: true, hint: "…4f2a" } });

    expect(state()).toContain("…4f2a");
    expect(ui.$("#s-key")!.textContent).not.toContain(KEY);
    expect(ui.$<HTMLInputElement>("#s-key-input")!.value).toBe("");
  });

  it("keeps the key off the screen while it is being typed", async () => {
    // A password field, because the developer reading over your shoulder is
    // the ordinary case in the room this is used in.
    await open();

    expect(ui.$<HTMLInputElement>("#s-key-input")!.type).toBe("password");
  });

  it("hands the key to the daemon on its own, not with the house rules", async () => {
    // The rules page saves everything at once. A secret must not ride in that
    // body, which is read back into the page every time it opens.
    await open();
    await ui.type(ui.$("#s-key-input"), KEY);
    await ui.click(ui.$("#s-key-save"));

    await waitFor(() => (sentKey() ? true : null), "the key to be sent");
    expect(sentKey()!.body).toEqual({ key: KEY });
    expect(ui.sent.find((s) => s.url.endsWith("/api/settings"))).toBeUndefined();
  });

  it("shows the key it now holds, and clears what was typed", async () => {
    await open();
    await ui.type(ui.$("#s-key-input"), KEY);
    await ui.click(ui.$("#s-key-save"));

    await waitFor(() => (state().includes("…4f2a") ? true : null), "the saved key");
    expect(ui.$<HTMLInputElement>("#s-key-input")!.value).toBe("");
  });

  it("says so when the daemon turns the key away", async () => {
    await open({ keyReply: { status: 400, body: { error: "The API turned that key away." } } });
    await ui.type(ui.$("#s-key-input"), "sk-ant-wrong");
    await ui.click(ui.$("#s-key-save"));

    await waitFor(() => ui.$("#s-key-error"), "the refusal");
    expect(ui.$("#s-key-error")!.textContent).toContain("turned that key away");
  });

  it("admits when a key was kept but never checked", async () => {
    // Kept, because an offline machine is not a wrong key - but said out
    // loud, because an unproven key fails slowly and far from here.
    await open({ keyReply: { status: 200, body: { present: true, hint: "…4f2a", verified: false } } });
    await ui.type(ui.$("#s-key-input"), KEY);
    await ui.click(ui.$("#s-key-save"));

    await waitFor(() => (state().includes("could not") ? true : null), "the warning");
  });

  it("gives the key back when it is removed", async () => {
    await open({ apiKey: { present: true, hint: "…4f2a" } });
    await ui.click(ui.$("#s-key-remove"));

    await waitFor(() => (state().includes("login") ? true : null), "the empty state");
  });

  it("says plainly that the key lasts only as long as the daemon", async () => {
    // It is held in memory. A developer who thinks it was saved comes back
    // tomorrow to a bench that quietly went back to its own login.
    await open();

    expect(ui.$("#s-key-note")!.textContent).toContain("restart");
  });
});
