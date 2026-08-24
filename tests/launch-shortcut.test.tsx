/**
 * @vitest-environment jsdom
 * @vitest-environment-options { "url": "http://localhost/?token=t" }
 */
import { describe, it, expect, afterEach } from "vitest";
import { bootCockpit, row, type Cockpit } from "./helpers/cockpit.js";
import { waitFor } from "./helpers/wait-for.js";

/**
 * The installed app's one shortcut, which a long press on the icon offers.
 *
 * It is the reason you open Bench from a home screen at all: not to browse,
 * but to clear whatever is waiting. The manifest promises this lands on the
 * queue, so it has to land on the queue.
 */

let ui: Cockpit;
afterEach(() => {
  ui?.unmount();
  history.pushState({}, "", "/?token=t");
});

const waiting = () => row({ id: "a", label: "ui-designer", latestReportSeq: 1, answeredReportSeq: null });

describe("launching at #queue", () => {
  it("opens the queue", async () => {
    history.pushState({}, "", "/?token=t#queue");
    ui = await bootCockpit({ rows: [] });
    await ui.roster([waiting()]);

    await waitFor(() => ui.$("#queue-current"), "the queue");
  });

  it("takes the hash back out, so a reload does not reopen it", async () => {
    history.pushState({}, "", "/?token=t#queue");
    ui = await bootCockpit({ rows: [] });

    expect(location.hash).toBe("");
    // And the token, which is the rest of the URL, is untouched.
    expect(location.search).toBe("?token=t");
  });

  it("leaves an ordinary launch alone", async () => {
    ui = await bootCockpit({ rows: [] });
    await ui.roster([waiting()]);

    expect(ui.$("#queue-current")).toBeNull();
  });
});
