/**
 * @vitest-environment jsdom
 * @vitest-environment-options { "url": "http://localhost/?token=t" }
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { createRoot } from "react-dom/client";
import { act } from "react";
import { bootCockpit, row, type Cockpit } from "./helpers/cockpit.js";
import { showProject } from "../src/client/hidden.js";

/**
 * A bench collects projects, and most of them are finished. Hiding one is a
 * tidy-up of the list in front of you - not an archive, not a close: the
 * specialists in there keep working, and the way back has to be somewhere you
 * would think to look.
 */
const KEY = "bench:hidden-projects";

let ui: Cockpit;
afterEach(() => {
  ui?.unmount();
  // The store outlives one test, so put back whatever the test hid.
  for (const project of JSON.parse(localStorage.getItem(KEY) ?? "[]")) showProject(project);
  localStorage.clear();
  vi.restoreAllMocks();
  history.pushState({}, "", "/?token=t");
});

const rows = [
  row({ id: "a", label: "ui-designer", project: "/var/www/bench" }),
  row({ id: "b", label: "payouts", project: "/var/www/teledoctor" }),
];

const headings = () => ui.$$("details.group > summary > span:first-child").map((s) => s.textContent);
const hideButtons = () => ui.$$(".hide-project");
const stored = () => JSON.parse(localStorage.getItem(KEY) ?? "[]");

describe("hiding a project", () => {
  it("takes it out of the roster and leaves the rest", async () => {
    ui = await bootCockpit({ rows });
    expect(headings()).toEqual(["bench", "teledoctor"]);

    await ui.click(hideButtons()[1]);

    expect(headings()).toEqual(["bench"]);
    expect(ui.$$(".row")).toHaveLength(1);
  });

  it("does not fold the group it was clicked in", async () => {
    ui = await bootCockpit({ rows });
    await ui.click(hideButtons()[1]);
    // A click inside a summary is a fold unless it is stopped, and the group
    // that is left must not have swallowed the one that went.
    expect((ui.$$("details.group")[0] as HTMLDetailsElement).open).toBe(true);
  });

  it("is remembered by the browser", async () => {
    ui = await bootCockpit({ rows });
    await ui.click(hideButtons()[0]);
    expect(stored()).toEqual(["/var/www/bench"]);
  });

  it("says how many are hidden, at the foot of the pane", async () => {
    ui = await bootCockpit({ rows });
    expect(ui.$("#hidden-count")).toBeNull();

    await ui.click(hideButtons()[0]);
    // Otherwise a roster missing a project has no way to explain itself.
    expect(ui.$("#hidden-count")!.textContent).toBe("1 hidden");
  });

  it("keeps the specialists — they are only out of the list", async () => {
    ui = await bootCockpit({ rows });
    await ui.click(hideButtons()[1]);

    // Nothing was closed: no request went anywhere.
    expect(ui.sent).toEqual([]);
  });

  it("still lets a hidden specialist say it wants you", async () => {
    ui = await bootCockpit({
      rows: [
        rows[0],
        row({ id: "b", label: "payouts", project: "/var/www/teledoctor", latestReportSeq: 2 }),
      ],
    });
    const before = ui.$("#queue-badge")!.textContent;
    expect(before).not.toBe("0");

    await ui.click(hideButtons()[1]);

    // Hiding tidies the list. It must not be a way to lose a decision - the
    // queue counts every project, hidden or not.
    expect(headings()).toEqual(["bench"]);
    expect(ui.$("#queue-badge")!.textContent).toBe(before);
  });
});

describe("settings, where they come back", () => {
  const openSettings = async () => { await ui.click(ui.$("#open-settings")); };

  it("says so when nothing is hidden", async () => {
    ui = await bootCockpit({ rows });
    await openSettings();
    expect(ui.$("#s-hidden-none")).not.toBeNull();
    expect(ui.$("#s-hidden-list")).toBeNull();
  });

  it("lists what is hidden and puts it back", async () => {
    ui = await bootCockpit({ rows });
    await ui.click(hideButtons()[1]);
    await openSettings();

    const listed = ui.$$("#s-hidden-list .s-hidden-name").map((n) => n.textContent);
    expect(listed).toEqual(["teledoctor"]);

    await ui.click(ui.$("#s-hidden-list button"));

    // The roster and the sheet read one store, so both are right at once.
    expect(headings()).toEqual(["bench", "teledoctor"]);
    expect(ui.$("#s-hidden-none")).not.toBeNull();
    expect(stored()).toEqual([]);
  });
});

describe("making a specialist somewhere hidden", () => {
  it("unhides the project rather than swallowing what you just made", async () => {
    ui = await bootCockpit({ rows, projects: [{ name: "teledoctor", path: "/var/www/teledoctor" }] });
    await ui.click(hideButtons()[1]);
    expect(headings()).toEqual(["bench"]);

    await ui.click(ui.$("#new-session"));
    await ui.type(ui.$("#f-project"), "teledoctor");
    await ui.type(ui.$("#f-label"), "Refunds");
    await ui.click(ui.$("#f-create"));

    expect(stored()).toEqual([]);
    expect(headings()).toEqual(["bench", "teledoctor"]);
  });
});

describe("after a refresh", () => {
  it("the store reads what the last visit hid", async () => {
    localStorage.setItem(KEY, JSON.stringify(["/var/www/teledoctor"]));
    vi.resetModules();
    const { useHiddenProjects } = await import("../src/client/hidden.js");

    // A probe rather than the whole cockpit: what is being tested is that the
    // store reads storage when the page loads, once, before anything renders.
    let seen: ReadonlySet<string> = new Set();
    const Probe = () => { seen = useHiddenProjects(); return null; };
    const host = document.createElement("div");
    const root = createRoot(host);
    await act(async () => { root.render(<Probe />); });

    expect([...seen]).toEqual(["/var/www/teledoctor"]);
    act(() => root.unmount());
  });
});
