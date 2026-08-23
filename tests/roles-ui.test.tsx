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
