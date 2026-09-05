/**
 * @vitest-environment jsdom
 * @vitest-environment-options { "url": "http://localhost/?token=t" }
 */
import { describe, it, expect, afterEach } from "vitest";
import { bootCockpit, row, type Cockpit } from "./helpers/cockpit.js";

/**
 * A specialist's first read, still on its way.
 *
 * `useThread`'s `entries` is `[]` for this exactly the same way it is for a
 * genuinely silent specialist or one #62's fix already covers - the three
 * used to be one state. Selecting a specialist whose thread has not loaded
 * used to say "Working. Nothing to read yet" about it, which is the same
 * false statement #62 fixed for a dropped read, arriving through a
 * different door (#80).
 */

let ui: Cockpit;
afterEach(() => {
  ui?.unmount();
  history.pushState({}, "", "/?token=t");
});

const thread = () => ui.$("#thread")!;
const box = () => ui.$<HTMLTextAreaElement>("#composer-text")!;

describe("a thread that has not loaded yet", () => {
  it("shows the skeleton, not 'Nothing to read yet'", async () => {
    ui = await bootCockpit({ rows: [row()], threadHangs: true });
    await ui.open("auth");

    expect(thread().querySelectorAll(".entry").length).toBeGreaterThan(0);
    expect(thread().textContent).not.toContain("Nothing to read yet");
    expect(thread().textContent).not.toContain("Can't reach this machine");
  });

  it("does not ask what a mid-conversation specialist is for while its read is still in flight", async () => {
    ui = await bootCockpit({ rows: [row()], threadHangs: true });
    await ui.open("auth");

    expect(box().placeholder).not.toBe("What should this specialist do?");
  });
});
