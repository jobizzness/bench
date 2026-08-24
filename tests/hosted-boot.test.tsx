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
 * the page cannot draw a roster, a thread or a queue. What it can do is ask
 * the one question it needs answered, which is where Bench is running.
 */

let ui: Cockpit;
afterEach(() => ui?.unmount());

describe("a hosted cockpit's first run", () => {
  it("asks where Bench is running", async () => {
    ui = await bootCockpit({ rows: [] });
    expect(document.querySelector("#server-setup")).not.toBeNull();
  });

  it("offers no way to dismiss it, since there is nothing behind it", async () => {
    ui = await bootCockpit({ rows: [] });
    expect(document.querySelector(".setup-cancel")).toBeNull();
  });

  it("does not open a socket to an origin it knows nothing about", async () => {
    // https://bench-cockpit.web.app/events is not a daemon, and asking would
    // only produce an error the developer cannot act on.
    ui = await bootCockpit({ rows: [] });
    await ui.drop();
    expect(document.querySelector("#offline")).toBeNull();
  });
});
