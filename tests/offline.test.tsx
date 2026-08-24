/**
 * @vitest-environment jsdom
 * @vitest-environment-options { "url": "http://localhost/?token=t" }
 */
import { describe, it, expect, afterEach } from "vitest";
import { bootCockpit, row, type Cockpit } from "./helpers/cockpit.js";
import { UNAUTHORIZED } from "../src/client/reconnect.js";

/**
 * What the cockpit says when the daemon is not answering.
 *
 * Installed to a home screen this is an ordinary morning, not an edge case:
 * the app opens whether or not the machine it supervises is awake. The thing
 * it must never do is what it used to do - draw an empty roster in silence,
 * which is indistinguishable from having lost every specialist.
 */

let ui: Cockpit;
afterEach(() => ui?.unmount());

describe("the daemon not answering", () => {
  it("says nothing while the socket is still coming up", async () => {
    ui = await bootCockpit({ rows: [] });
    expect(ui.$("#offline")).toBeNull();
  });

  it("says so when the socket drops", async () => {
    ui = await bootCockpit({ rows: [] });
    await ui.connect();
    expect(ui.$("#offline")).toBeNull();

    await ui.drop();
    expect(ui.$("#offline")!.textContent).toContain("Not connected");
  });

  it("keeps the roster on screen, and says it is the last thing it heard", async () => {
    ui = await bootCockpit({ rows: [] });
    await ui.connect();
    await ui.roster([row({ id: "a", label: "auth" }), row({ id: "b", label: "billing" })]);

    await ui.drop();

    // A specialist does not stop existing because the page lost its socket,
    // and a roster of nobody is what losing them all looks like.
    expect(ui.$$(".row")).toHaveLength(2);
    expect(ui.$("#offline")!.textContent).toContain("the last it said");
  });

  it("clears itself when the daemon comes back", async () => {
    ui = await bootCockpit({ rows: [] });
    await ui.connect();
    await ui.drop();
    expect(ui.$("#offline")).not.toBeNull();

    await ui.connect();
    expect(ui.$("#offline")).toBeNull();
  });

  it("leaves a refused socket to the stale banner", async () => {
    // Two banners for one silence, and only one of them can be acted on.
    ui = await bootCockpit({ rows: [] });
    await ui.connect();
    await ui.drop(UNAUTHORIZED);

    expect(ui.$("#offline")).toBeNull();
    expect(document.querySelector("#stale")).not.toBeNull();
  });
});
