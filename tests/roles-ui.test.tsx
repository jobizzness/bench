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

    expect(metaOf(ui.$(".row")!)).toEqual(["implementer", "Bash pnpm test", "Opus 5"]);
  });

  it("says the status on the stage, where there is no rail to read it off", async () => {
    ui = await bootCockpit({ rows: [
      row({ label: "payouts", role: "implementer", status: "working", detail: "Bash pnpm test" }),
    ] });
    await ui.open("payouts");

    // Badges first, then the prose. The header sets its facts as things you
    // can see rather than clauses you have to read; the detail stays prose
    // because it is a sentence the specialist wrote.
    expect(metaOf(ui.$("#stage-head")!))
      .toEqual(["implementer", "Opus 5", "working", "bench/auth-abcd1234", "Bash pnpm test"]);
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

  it("says in your checkout in the header, and not on the row", async () => {
    // It is a standing fact about how the specialist was made, not something
    // that changes or that you act on from the roster - and on a 276px row it
    // took the space the detail needed. The header has room to say it
    // properly, as a badge.
    ui = await bootCockpit({ rows: [row({ label: "quick-look", branch: "main", isolated: false })] });
    await ui.open("quick-look");

    expect(metaOf(ui.$(".row")!)).not.toContain("in your checkout");
    expect(ui.$(".row .badge-shared")).toBeNull();

    expect(metaOf(ui.$("#stage-head")!)).toContain("in your checkout");
    expect(ui.$("#stage-head .badge-shared")).not.toBeNull();
  });

  it("says nothing about where when it has its own worktree", async () => {
    // The normal case, and the header stays quiet about it too.
    ui = await bootCockpit({ rows: [row({ label: "auth" })] });
    await ui.open("auth");
    expect(ui.$(".row .badge-shared")).toBeNull();
    expect(ui.$("#stage-head .badge-shared")).toBeNull();
  });

  it("says nothing at all while the worktree is still being made", async () => {
    ui = await bootCockpit({ rows: [
      row({ label: "new-one", branch: "", status: "provisioning", detail: "creating worktree" }),
    ] });
    await ui.open("new-one");

    expect(metaOf(ui.$("#stage-head")!))
      .toEqual(["specialist", "Opus 5", "provisioning", "creating worktree"]);
  });
});

describe("how full a conversation is", () => {
  const context = { used: 150_000, window: 200_000 };

  it("says so on the stage, where you are looking at one specialist", async () => {
    ui = await bootCockpit({ rows: [row({ label: "auth", context: { used: 20_000, window: 200_000 } })] });
    await ui.open("auth");

    // A ring, not a sentence. The number is on the hover, where you go when
    // you want the exact one.
    const meter = ui.$("#stage-head .meta-context")!;
    expect(meter).not.toBeNull();
    expect(meter.getAttribute("title")).toBe("10% of the conversation used");
  });

  it("stays off a roster row until it is close", async () => {
    // Every row carrying a percentage is a column of numbers nobody reads.
    ui = await bootCockpit({ rows: [
      row({ id: "a", label: "early", context: { used: 20_000, window: 200_000 } }),
      row({ id: "b", label: "late", context }),
    ] });

    expect(ui.$$(".row")[0].querySelector(".meta-context")).toBeNull();
    expect(ui.$$(".row")[1].querySelector(".meta-context")?.getAttribute("title"))
      .toBe("75% of the conversation used");
  });

  it("colours it only once it is worth acting on", async () => {
    ui = await bootCockpit({ rows: [row({ label: "late", context })] });
    await ui.open("late");

    expect(ui.$(".meta-context")!.getAttribute("data-tone")).toBe("high");
  });

  it("says nothing at all for a specialist that has never taken a turn", async () => {
    ui = await bootCockpit({ rows: [row({ label: "fresh", context: null })] });
    await ui.open("fresh");

    expect(ui.$(".meta-context")).toBeNull();
  });
});
