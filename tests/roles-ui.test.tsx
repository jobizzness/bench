/**
 * @vitest-environment jsdom
 * @vitest-environment-options { "url": "http://localhost/?token=t" }
 */
import { describe, it, expect, afterEach } from "vitest";
import { bootCockpit, row, type Cockpit } from "./helpers/cockpit.js";

/**
 * A tab named for its task said nothing about whether it builds or reads.
 * The role is a name on the roster and nothing more, so all there is to prove
 * is that it is on screen where the agent is.
 */

let ui: Cockpit;
afterEach(() => {
  ui?.unmount();
  history.pushState({}, "", "/?token=t");
});

describe("what kind of agent each one is", () => {
  it("says the role beside the name, on every row", async () => {
    ui = await bootCockpit({ rows: [
      row({ id: "a", label: "payouts", role: "implementer" }),
      row({ id: "b", label: "payouts-review", role: "reviewer" }),
    ] });

    expect(ui.$$(".row .role").map((r) => r.textContent)).toEqual(["implementer", "reviewer"]);
  });

  it("keeps the specialists labelled too, rather than only the unusual ones", async () => {
    // The question was what kind each one is. Answering for three of four
    // leaves the fourth looking like a row that failed to load.
    ui = await bootCockpit({ rows: [row({ label: "auth", role: "specialist" })] });
    expect(ui.$(".row .role")!.textContent).toBe("specialist");
  });

  it("says it on the stage too, for whoever is in front of you", async () => {
    ui = await bootCockpit({ rows: [row({ label: "payouts", role: "researcher" })] });
    await ui.open("payouts");

    expect(ui.$("#stage-head .role")!.textContent).toBe("researcher");
  });

  it("leaves the name findable beside it", async () => {
    // The badge sits inside the label, so anything reading the row's name has
    // to still get the name.
    ui = await bootCockpit({ rows: [row({ label: "payouts", role: "reviewer" })] });
    expect(ui.$(".row .label")!.firstChild!.textContent).toBe("payouts");
  });
});

describe("where a specialist is working", () => {
  it("names the branch on the stage", async () => {
    ui = await bootCockpit({ rows: [row({ label: "auth", branch: "bench/auth-abcd1234" })] });
    await ui.open("auth");

    expect(ui.$(".where-branch")!.textContent).toBe("bench/auth-abcd1234");
  });

  it("says plainly when one is in your checkout rather than its own worktree", async () => {
    // This is the one worth seeing: it edits the files you have open, on the
    // branch you are on.
    ui = await bootCockpit({ rows: [row({ label: "quick-look", branch: "main", isolated: false })] });
    await ui.open("quick-look");

    expect(ui.$(".where-shared")!.textContent).toBe("your checkout");
    expect(ui.$(".where")!.getAttribute("title")).toContain("Working in your checkout, on main");
  });

  it("marks that one on the roster too, where you are choosing between them", async () => {
    ui = await bootCockpit({ rows: [
      row({ id: "a", label: "auth" }),
      row({ id: "b", label: "quick-look", branch: "main", isolated: false }),
    ] });

    const marked = ui.$$(".row").map((r) => r.querySelector(".row-shared") !== null);
    expect(marked).toEqual([false, true]);
  });

  it("says nothing at all while the worktree is still being made", async () => {
    // A branch it does not have yet is not a branch worth naming.
    ui = await bootCockpit({ rows: [row({ label: "new-one", branch: "", status: "provisioning" })] });
    await ui.open("new-one");

    expect(ui.$(".where")).toBeNull();
  });
});
