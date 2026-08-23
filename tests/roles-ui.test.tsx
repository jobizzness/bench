/**
 * @vitest-environment jsdom
 * @vitest-environment-options { "url": "http://localhost/?token=t" }
 */
import { describe, it, expect, afterEach } from "vitest";
import { bootCockpit, row, type Cockpit } from "./helpers/cockpit.js";

/**
 * Everything about a specialist that is not its name sits on one quiet line.
 * What these hold in place is the order of it, and the one segment that is
 * allowed to raise its voice.
 */

let ui: Cockpit;
afterEach(() => {
  ui?.unmount();
  history.pushState({}, "", "/?token=t");
});

const metaOf = (rowEl: Element) =>
  [...rowEl.querySelectorAll(".meta > *")].map((s) => s.textContent);

describe("what kind of agent each one is", () => {
  it("leads the line with the role, on every row", async () => {
    // The left edge of the column is then the shape of your bench, readable
    // without reading a word of the rest.
    ui = await bootCockpit({ rows: [
      row({ id: "a", label: "payouts", role: "implementer", detail: "editing invoice.ts" }),
      row({ id: "b", label: "payouts-review", role: "reviewer", detail: "three findings" }),
    ] });

    expect(ui.$$(".row").map((r) => metaOf(r)[0])).toEqual(["implementer", "reviewer"]);
  });

  it("names the specialists too, rather than only the unusual ones", async () => {
    ui = await bootCockpit({ rows: [row({ label: "auth", role: "specialist" })] });
    expect(metaOf(ui.$(".row")!)[0]).toBe("specialist");
  });

  it("does not repeat the status the rail is already showing", async () => {
    // The rail is coloured and it breathes while a turn runs. Saying
    // "working" beside it spends a third of the line on a fact already told.
    ui = await bootCockpit({ rows: [
      row({ label: "payouts", role: "implementer", status: "working", detail: "Bash pnpm test" }),
    ] });

    expect(metaOf(ui.$(".row")!)).toEqual(["implementer", "Bash pnpm test"]);
  });

  it("says the status on the stage, where there is no rail to read it off", async () => {
    ui = await bootCockpit({ rows: [
      row({ label: "payouts", role: "implementer", status: "working", detail: "Bash pnpm test" }),
    ] });
    await ui.open("payouts");

    expect(metaOf(ui.$("#stage-head")!))
      .toEqual(["implementer", "working", "Bash pnpm test", "bench/auth-abcd1234"]);
  });
});

describe("where a specialist is working", () => {
  it("names the branch on the stage, and not on the row", async () => {
    // A row is where you choose between them; the branch is what you read
    // once you have.
    ui = await bootCockpit({ rows: [row({ label: "auth", branch: "bench/auth-abcd1234" })] });
    await ui.open("auth");

    expect(metaOf(ui.$("#stage-head")!)).toContain("bench/auth-abcd1234");
    expect(metaOf(ui.$(".row")!)).not.toContain("bench/auth-abcd1234");
  });

  it("says in your checkout, in both places, when that is where it is", async () => {
    // The one thing on the line that is a warning rather than a fact.
    ui = await bootCockpit({ rows: [row({ label: "quick-look", branch: "main", isolated: false })] });
    await ui.open("quick-look");

    expect(metaOf(ui.$(".row")!)).toContain("in your checkout");
    expect(ui.$(".row .meta-shared")).not.toBeNull();
    expect(metaOf(ui.$("#stage-head")!)).toContain("in your checkout");
  });

  it("says nothing about where when it has its own worktree", async () => {
    // The normal case. A line that says it on every row says nothing.
    ui = await bootCockpit({ rows: [row({ label: "auth" })] });
    expect(ui.$(".row .meta-shared")).toBeNull();
  });

  it("says nothing at all while the worktree is still being made", async () => {
    ui = await bootCockpit({ rows: [
      row({ label: "new-one", branch: "", status: "provisioning", detail: "creating worktree" }),
    ] });
    await ui.open("new-one");

    expect(metaOf(ui.$("#stage-head")!))
      .toEqual(["specialist", "provisioning", "creating worktree"]);
  });
});
