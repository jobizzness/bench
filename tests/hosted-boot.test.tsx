/**
 * @vitest-environment jsdom
 * @vitest-environment-options { "url": "https://bench-cockpit.web.app/" }
 */
import { describe, it, expect, afterEach } from "vitest";
import { bootCockpit, type Cockpit } from "./helpers/cockpit.js";

/**
 * The cockpit opened from somewhere that is not a daemon.
 *
 * Hosted, there is no token in the URL and no daemon behind the origin, so
 * the page cannot draw a roster, a thread or a queue. With nobody signed
 * into Firebase either, what it shows is `SignIn` - not "Where is Bench
 * running?", which used to be the dead end this ticket exists to fix. See
 * "The phone's first screen is sign-in" in the design.
 */

let ui: Cockpit;
afterEach(() => ui?.unmount());

describe("a hosted cockpit's first run", () => {
  it("offers to sign in rather than asking where Bench is running", async () => {
    ui = await bootCockpit({ rows: [] });
    expect(document.querySelector("#sign-in")).not.toBeNull();
    expect(document.querySelector("#server-setup")).toBeNull();
  });

  it("offers a way to reach the address dialog anyway, for someone who meant to type one", async () => {
    ui = await bootCockpit({ rows: [] });
    await ui.click(ui.$("#sign-in-use-address"));
    expect(document.querySelector("#server-setup")).not.toBeNull();
  });

  it("does not open a socket to an origin it knows nothing about", async () => {
    // https://bench-cockpit.web.app/events is not a daemon, and asking would
    // only produce an error the developer cannot act on.
    ui = await bootCockpit({ rows: [] });
    await ui.drop();
    expect(document.querySelector("#offline")).toBeNull();
  });
});
