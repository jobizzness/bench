/**
 * @vitest-environment jsdom
 * @vitest-environment-options { "url": "http://localhost/?token=t" }
 */
import { describe, it, expect, afterEach } from "vitest";
import { bootCockpit, row, entry, type Cockpit, type Fixtures } from "./helpers/cockpit.js";

/**
 * #82: a specialist or a message genuinely new gets a one-shot arrival, a
 * cold load or a re-render of something already known does not. jsdom
 * cannot run the CSS transition itself or fire `transitionend` (see #82's
 * own note on that), so what these prove is the part that matters upstream
 * of the pixels: which element gets the entering class at all, once, and
 * only the once - not whether #82's own reopened-pane and reopened-details
 * cases stay quiet, which is a browser check (see the issue).
 */

let ui: Cockpit;
afterEach(() => {
  ui?.unmount();
  history.pushState({}, "", "/?token=t");
});

const rowFor = (label: string) => ui.$$(".row[data-status]").find(
  (node) => node.querySelector(".label-name")?.textContent === label,
);

describe("a roster row's arrival", () => {
  it("marks nothing on the roster this client opens on", async () => {
    ui = await bootCockpit({ rows: [row({ id: "s1", label: "one" }), row({ id: "s2", label: "two" })] });
    expect(rowFor("one")?.className).not.toMatch(/row-entering/);
    expect(rowFor("two")?.className).not.toMatch(/row-entering/);
  });

  it("marks only a specialist genuinely new to a later push", async () => {
    ui = await bootCockpit({ rows: [row({ id: "s1", label: "one" })] });
    await ui.roster([row({ id: "s1", label: "one" }), row({ id: "s2", label: "two" })]);
    expect(rowFor("one")?.className).not.toMatch(/row-entering/);
    expect(rowFor("two")?.className).toMatch(/row-entering/);
  });

  it("does not re-mark a row a later push merely repeats", async () => {
    ui = await bootCockpit({ rows: [row({ id: "s1", label: "one" })] });
    await ui.roster([row({ id: "s1", label: "one" }), row({ id: "s2", label: "two" })]);
    // Several pushes a second is the ordinary case (RosterGroup.tsx's own
    // comment) - none of them should touch a row already accounted for.
    await ui.roster([row({ id: "s1", label: "one" }), row({ id: "s2", label: "two", status: "working" })]);
    expect(rowFor("one")?.className).not.toMatch(/row-entering/);
  });
});

describe("a thread entry's arrival", () => {
  const bootWithThread = (fixtures: Omit<Fixtures, "rows">) =>
    bootCockpit({ rows: [row({ id: "s1", label: "one" })], ...fixtures });

  it("marks nothing on the thread a specialist is first opened to", async () => {
    ui = await bootWithThread({ entries: [entry({ seq: 1, body: "hello" }), entry({ seq: 2, body: "world" })] });
    await ui.open("one");
    for (const node of ui.$$(".entry")) expect(node.className).not.toMatch(/entry-entering/);
  });

  it("marks only a message genuinely new to the conversation", async () => {
    const fixtures: Fixtures = {
      rows: [row({ id: "s1", label: "one", latestReportSeq: null })],
      entries: [entry({ seq: 1, body: "hello" })],
    };
    ui = await bootCockpit(fixtures);
    await ui.open("one");
    expect(ui.$$(".entry")).toHaveLength(1);

    // A report landing is what bumps `threadSignature` (useThread.ts) and
    // triggers the refetch - the same shape a real turn ending takes.
    fixtures.entries = [entry({ seq: 1, body: "hello" }), entry({ seq: 2, body: "a report landed", kind: "report", reportSeq: 1 } as any)];
    await ui.roster([row({ id: "s1", label: "one", latestReportSeq: 1 })]);

    const entries = ui.$$(".entry");
    expect(entries).toHaveLength(2);
    expect(entries[0].className).not.toMatch(/entry-entering/);
    expect(entries[1].className).toMatch(/entry-entering/);
  });

  it("does not re-mark old entries on returning to a specialist already read", async () => {
    const fixtures: Fixtures = {
      rows: [row({ id: "s1", label: "one" }), row({ id: "s2", label: "two" })],
      entries: [entry({ seq: 1, body: "hello" })],
    };
    ui = await bootCockpit(fixtures);
    await ui.open("one");
    await ui.open("two");
    await ui.open("one");
    for (const node of ui.$$(".entry")) expect(node.className).not.toMatch(/entry-entering/);
  });
});
