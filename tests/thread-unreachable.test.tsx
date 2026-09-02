/**
 * @vitest-environment jsdom
 * @vitest-environment-options { "url": "http://localhost/?token=t" }
 */
import { describe, it, expect, afterEach } from "vitest";
import { bootCockpit, entry, row, type Cockpit } from "./helpers/cockpit.js";

/**
 * A read that did not land is not a specialist that has said nothing.
 *
 * Both arrived as `[]`, so a dropped read drew "Working. Nothing to read yet"
 * over a conversation hundreds of entries long, and changed the composer to
 * ask what the specialist was for. Photographed on a phone, where the relay
 * genuinely drops several reads an hour — the daemon log names them as
 * connect timeouts, resets and DNS failures against firestore.googleapis.com
 * (#62).
 */

let ui: Cockpit;
afterEach(() => {
  ui?.unmount();
  history.pushState({}, "", "/?token=t");
});

const thread = () => ui.$("#thread")!;
const box = () => ui.$<HTMLTextAreaElement>("#composer-text")!;

describe("a thread that could not be read", () => {
  it("says it could not reach the machine, not that there is nothing to read", async () => {
    ui = await bootCockpit({ rows: [row()], threadFails: "reject" });
    await ui.open("auth");

    expect(thread().textContent).toContain("Can't reach this machine");
    expect(thread().textContent).not.toContain("Nothing to read yet");
  });

  it("says the same when the daemon answers with a status rather than dying", async () => {
    ui = await bootCockpit({ rows: [row()], threadFails: 502 });
    await ui.open("auth");

    expect(thread().textContent).toContain("Can't reach this machine");
  });

  it("does not ask what the specialist is for when the thread simply did not arrive", async () => {
    // The placeholder keys off an empty thread, so a dropped read asked a
    // specialist mid-conversation what it was for.
    ui = await bootCockpit({ rows: [row()], threadFails: "reject" });
    await ui.open("auth");

    expect(box().placeholder).not.toBe("What should this specialist do?");
  });

  it("still reads as empty when the thread genuinely is", async () => {
    ui = await bootCockpit({ rows: [row()], entries: [] });
    await ui.open("auth");

    expect(thread().textContent).toContain("Nothing to read yet");
    expect(thread().textContent).not.toContain("Can't reach");
  });

  it("asks what a genuinely empty specialist is for, as it always did", async () => {
    ui = await bootCockpit({ rows: [row()], entries: [] });
    await ui.open("auth");

    expect(box().placeholder).toBe("What should this specialist do?");
  });

  it("shows what it has, and says it is the last that arrived", async () => {
    const fixtures: Parameters<typeof bootCockpit>[0] = {
      rows: [row({ status: "working", detail: "thinking" })],
      entries: [entry({ body: "the earlier answer" })],
    };
    ui = await bootCockpit(fixtures);
    await ui.open("auth");
    expect(thread().textContent).toContain("the earlier answer");

    // The link drops, and a roster push is what triggers the refetch.
    fixtures.threadFails = "reject";
    await ui.roster([row({ status: "done", detail: "idle" })]);

    expect(thread().textContent).toContain("the earlier answer");
    expect(thread().textContent).toContain("Lost the connection");
  });

  it("clears the warning once a read lands again", async () => {
    const fixtures: Parameters<typeof bootCockpit>[0] = {
      rows: [row({ status: "working", detail: "thinking" })],
      entries: [entry({ body: "the earlier answer" })],
    };
    ui = await bootCockpit(fixtures);
    await ui.open("auth");

    fixtures.threadFails = "reject";
    await ui.roster([row({ status: "done", detail: "idle" })]);
    expect(thread().textContent).toContain("Lost the connection");

    fixtures.threadFails = undefined;
    await ui.roster([row({ status: "working", detail: "thinking again" })]);
    expect(thread().textContent).not.toContain("Lost the connection");
  });
});
