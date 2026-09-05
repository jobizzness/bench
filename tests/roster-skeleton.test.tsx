/**
 * @vitest-environment jsdom
 * @vitest-environment-options { "url": "http://localhost/?token=t" }
 */
import { describe, it, expect, afterEach } from "vitest";
import { bootCockpit, row, type Cockpit } from "./helpers/cockpit.js";

/**
 * An empty roster is two different facts, and only one of them gets a
 * skeleton: the socket has not settled yet (or has, and is live, and really
 * has nobody on it) draws the shape of rows to come; a socket that has gone
 * down has its own banner for that, and a skeleton on top of it would
 * promise a roster that is not coming (#80).
 */

let ui: Cockpit;
afterEach(() => {
  ui?.unmount();
  history.pushState({}, "", "/?token=t");
});

const skeletonRows = () => ui.$$("#roster-list .row.skeleton-row");

describe("an empty roster", () => {
  it("shows skeleton rows before the socket has settled", async () => {
    ui = await bootCockpit({ rows: [] });
    expect(skeletonRows().length).toBeGreaterThan(0);
  });

  it("shows skeleton rows once the socket is up and genuinely has nobody on it", async () => {
    ui = await bootCockpit({ rows: [] });
    await ui.connect();
    expect(skeletonRows().length).toBeGreaterThan(0);
  });

  it("does not show them once the socket is confirmed down", async () => {
    ui = await bootCockpit({ rows: [] });
    await ui.connect();
    await ui.drop();
    expect(skeletonRows()).toHaveLength(0);
    expect(ui.$("#offline")).not.toBeNull();
  });

  it("gives way to the real rows the moment they arrive", async () => {
    ui = await bootCockpit({ rows: [] });
    await ui.roster([row({ id: "a", label: "auth" })]);
    expect(skeletonRows()).toHaveLength(0);
    expect(ui.$$("#roster-list .row").length).toBe(1);
  });
});
