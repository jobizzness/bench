/**
 * @vitest-environment jsdom
 * @vitest-environment-options { "url": "http://localhost/?token=t" }
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { bootCockpit, row, type Cockpit } from "./helpers/cockpit.js";
import { waitFor } from "./helpers/wait-for.js";

/**
 * Pointing an editor at a project, from the roster (#129).
 *
 * The developer opens VS Code themselves, so nothing listening is an
 * ordinary state rather than a fault - which is exactly why the button has
 * to say which one happened. A control that looks identical whether it
 * worked or not is how a feature stops being trusted.
 */
let ui: Cockpit;
afterEach(() => {
  ui?.unmount();
  localStorage.clear();
  vi.restoreAllMocks();
  history.pushState({}, "", "/?token=t");
});

const rows = [
  row({ id: "a", label: "ui-designer", project: "/var/www/bench" }),
  row({ id: "b", label: "payouts", project: "/var/www/teledoctor" }),
];

const buttons = () => ui.$$(".target-editor");
const said = () => buttons().map((b) => b.textContent);

describe("pointing an editor at a project", () => {
  it("names the project it belongs to, not whichever was clicked last", async () => {
    ui = await bootCockpit({ rows });

    await ui.click(buttons()[1]);

    const posted = ui.sent.find((s) => s.url.includes("/api/editor/target"));
    expect(posted!.body).toEqual({ project: "/var/www/teledoctor" });
  });

  it("says so when an editor took it", async () => {
    ui = await bootCockpit({ rows, editorsTargeted: 1 });

    await ui.click(buttons()[0]);

    await waitFor(() => (said()[0] === "pointed" ? true : null), "the button to report success");
    expect(buttons()[0].getAttribute("data-outcome")).toBe("sent");
  });

  /** The case the whole control turns on. */
  it("says nobody was listening rather than drawing a tick", async () => {
    ui = await bootCockpit({ rows, editorsTargeted: 0 });

    await ui.click(buttons()[0]);

    await waitFor(() => (said()[0] === "no editor" ? true : null), "the button to report silence");
    expect(buttons()[0].getAttribute("data-outcome")).toBe("nobody");
  });

  it("leaves every other project's button alone", async () => {
    ui = await bootCockpit({ rows, editorsTargeted: 1 });

    await ui.click(buttons()[0]);
    await waitFor(() => (said()[0] === "pointed" ? true : null), "the first to report");

    expect(said()[1]).toBe("editor");
  });

  /** Inside a `<summary>`, an unstopped click folds the group. */
  it("does not fold the project it is inside", async () => {
    ui = await bootCockpit({ rows });
    const group = ui.$$("details.group")[0] as HTMLDetailsElement;
    const before = group.open;

    await ui.click(buttons()[0]);

    expect(group.open).toBe(before);
  });
});
