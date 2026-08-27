/**
 * @vitest-environment jsdom
 * @vitest-environment-options { "url": "http://localhost/?token=t" }
 */
import { describe, it, expect, afterEach } from "vitest";
import { bootCockpit, row, type Cockpit, type Fixtures } from "./helpers/cockpit.js";
import { waitFor } from "./helpers/wait-for.js";

/**
 * What this work has already cost.
 *
 * The meters beside this one say how much is left; none of them could say
 * what had been spent, because the only record of it was a field on a
 * specialist's row that was deleted along with the specialist. The ledger
 * outlives the roster, and this is the cockpit's view of it.
 *
 * The thing being defended here is that the panel never flattens what the
 * daemon kept apart: two kinds of money that must not be added, and a figure
 * that says how much of itself is a guess.
 */

/** The live bench this was written against. */
const LEDGER = { plan: 198.96, account: 10.24, turns: 41, estimated: 3.1 };

let ui: Cockpit;
afterEach(() => { ui?.unmount(); });

async function boot(over: Partial<Fixtures> = {}): Promise<void> {
  ui = await bootCockpit({ rows: [row({ model: "opus" })], spend: LEDGER, ...over });
  await ui.open("auth");
}

/** Open the ledger and read it. */
async function panel(): Promise<string> {
  await waitFor(() => ui.$("#open-spend"), "the spend meter");
  await ui.hover(ui.$("#open-spend"));
  await waitFor(() => ui.$("#spend-panel"), "the spend panel");
  return ui.$("#spend-panel")!.textContent ?? "";
}

describe("the two kinds of money", () => {
  it("says each one separately, and says which is a bill", async () => {
    await boot();

    const said = await panel();
    expect(said).toContain("$198.96");
    expect(said).toContain("$10.24");
    // Not just the figures - a reader who does not already know the
    // difference has to be able to tell which of them anyone will invoice.
    expect(said).toContain("on a subscription already paid for — not a bill");
    expect(said).toContain("cash out of your OpenRouter balance");
  });

  it("never adds them into one figure", async () => {
    // $209.20 is a number that is true of nothing: a subscription quoted at
    // list price is not money that left the account, and one total covering
    // both is the failure this whole feature exists to remove.
    await boot();

    const said = await panel();
    expect(said).not.toContain("209");
  });

  it("is mounted whatever account the next turn would be billed to", async () => {
    // Unlike the meters beside it. Which account pays next does not change
    // what the last hundred turns already cost, and both kinds are in here.
    await boot({ rows: [row({ model: "google/gemini-3.7-flash" })] });

    expect(await panel()).toContain("$198.96");
  });
});

describe("the estimated share", () => {
  it("says how much of the figure is a guess rather than a settled charge", async () => {
    await boot();

    const said = await panel();
    expect(said).toContain("$3.10");
    expect(said).toContain("a catalogue guess, not a settled charge");
    // The bias, not just the fact. The guess was measured under, so a
    // developer working out what they can afford needs to know which way it
    // leans.
    expect(said).toContain("1.46× under");
  });

  it("carries it on the mark as a texture, not only as a colour", async () => {
    await boot();
    await waitFor(() => ui.$("#open-spend"), "the spend meter");

    expect(ui.$(".spend-mark")!.getAttribute("data-estimated")).toBe("true");
    expect(ui.$(".spend-mark path")!.getAttribute("stroke-dasharray")).toBe("2 2");
  });

  it("says nothing at all when nothing is estimated", async () => {
    // An empty caveat is a caveat the reader has to stop and dismiss. A
    // ledger of settled charges is simply a ledger.
    await boot({ spend: { plan: 12, account: 0, turns: 3, estimated: 0 } });

    const said = await panel();
    expect(said).not.toContain("estimated");
    expect(said).not.toContain("guess");
    // And the mark goes back to solid, so the two states are told apart
    // without opening anything.
    expect(ui.$(".spend-mark")!.getAttribute("data-estimated")).toBeNull();
    expect(ui.$(".spend-mark path")!.getAttribute("stroke-dasharray")).toBeNull();
  });
});

describe("a ledger with nothing in it", () => {
  it("reads as nothing yet rather than as an error", async () => {
    await boot({ spend: { plan: 0, account: 0, turns: 0, estimated: 0 } });

    const said = await panel();
    expect(said).toContain("nothing yet");
    expect(said).toContain("no turn here has been billed");
  });

  it("does not call a total of nought free", async () => {
    // "free" is what the shared formatter calls zero, and it is right about
    // the price of a model. A project nobody has spent anything on has not
    // been given anything - it has just not started.
    await boot({ spend: { plan: 0, account: 0, turns: 0, estimated: 0 } });

    expect(await panel()).not.toContain("free");
  });

  it("draws no bill and no caveat", async () => {
    await boot({ spend: { plan: 0, account: 0, turns: 0, estimated: 0 } });

    const said = await panel();
    expect(said).not.toContain("$");
    expect(said).not.toContain("estimated");
  });
});

describe("this project against the whole bench", () => {
  /** A bench where the open specialist's project is a minority of the spend. */
  const split = (project?: string) => (project === "/var/www/demo"
    ? { plan: 20, account: 4, turns: 6, estimated: 0 }
    : { plan: 198.96, account: 10.24, turns: 41, estimated: 3.1 });

  it("asks about the project the open specialist belongs to", async () => {
    await boot({ spend: split });
    await waitFor(() => ui.$("#open-spend"), "the spend meter");

    expect(ui.fetched.some((url) => url.includes("/api/spend?project=")
      && decodeURIComponent(url).includes("/var/www/demo"))).toBe(true);
  });

  it("reports this project first, and the bench under it", async () => {
    // "What has this piece of work cost" is the question a developer has.
    // The bench total is reachable without going to another screen, but it is
    // not the headline, because it is not a number they can act on.
    await boot({ spend: split });

    const said = await panel();
    expect(said).toContain("this project · plan");
    expect(said).toContain("$20.00");
    expect(said).toContain("$4.00");
    expect(said).toContain("whole bench");
    expect(said).toContain("41 turns");
    expect(said).toContain("$198.96 on plan");
  });

  it("puts the project's figure on the button, not the bench's", async () => {
    await boot({ spend: split });
    await waitFor(() => ui.$("#open-spend"), "the spend meter");

    const said = ui.$("#open-spend")!.getAttribute("aria-label")!;
    expect(said).toContain("Spend on this project");
    expect(said).toContain("$20.00");
    expect(said).not.toContain("$198.96");
  });

  it("does not repeat itself when the project is the whole bench", async () => {
    // One project on the bench means the two totals are the same numbers
    // under two headings, which invites the reader to hunt for a difference
    // that is not there.
    await boot({ spend: LEDGER });

    expect(await panel()).not.toContain("whole bench");
  });

  it("counts turns from specialists that have since been closed", async () => {
    // The point of the ledger. The roster knows about survivors; 41 turns
    // across a bench showing one open specialist is the fact it exists for.
    await boot();

    const said = await panel();
    expect(said).toContain("41");
    expect(said).toContain("closed specialists included");
  });
});

describe("when the ledger cannot be read", () => {
  it("says so rather than drawing zero", async () => {
    // Every other failure down here resolves to a number that can be safely
    // ignored. This one must not: "nothing spent" is precisely the
    // comfortable answer a broken ledger would give.
    await boot({ spend: "unreachable" });

    const said = await panel();
    expect(said).toMatch(/could not read the spend ledger/i);
    expect(said).not.toContain("nothing yet");
    expect(said).not.toContain("$0");
  });

  it("draws nothing at all before the daemon has answered", async () => {
    // Not asked yet is not the same as nothing to report, and a meter that
    // appears empty and fills in a moment later reads as a bench that has
    // spent nothing.
    ui = await bootCockpit({
      rows: [row({ model: "opus" })],
      spend: () => new Promise(() => {}),
    });
    await ui.open("auth");

    expect(ui.$("#open-spend")).toBeNull();
  });
});

describe("living beside the meters that were already there", () => {
  it("leaves the account meter its own button and panel", async () => {
    // Two meters are up at once now, so neither can be the one that answers
    // to #open-usage.
    await boot({
      rows: [row({ model: "google/gemini-3.7-flash" })],
      credit: { available: true, spent: 12.4, limit: 50, balance: null },
    });

    await waitFor(() => ui.$("#open-usage"), "the account meter");
    expect(ui.$$("#open-usage")).toHaveLength(1);
    expect(ui.$$("#open-spend")).toHaveLength(1);

    // Opening one does not open the other.
    await ui.hover(ui.$("#open-spend"));
    await waitFor(() => ui.$("#spend-panel"), "the spend panel");
    expect(ui.$("#usage-panel")).toBeNull();
  });

  it("re-asks when a turn is billed, without waiting for a clock", async () => {
    // The ledger only changes when a turn ends, and the cockpit is already
    // told when that happens. Polling would be asking the daemon to re-read
    // an unchanged file sixty times an hour.
    let turns = 0;
    ui = await bootCockpit({
      rows: [row({ model: "opus" })],
      spend: () => ({ plan: turns * 2, account: 0, turns, estimated: 0 }),
    });
    await ui.open("auth");
    await waitFor(() => ui.$("#open-spend"), "the spend meter");

    turns = 5;
    // A roster push carrying a specialist that has now billed some turns,
    // which is exactly what the daemon sends at the end of one.
    await ui.roster([row({ model: "opus", spend: { dollars: 10, turns: 5, billed: "plan" } })]);

    await waitFor(
      () => (ui.$("#open-spend")!.getAttribute("aria-label")!.includes("5 turns") ? true : null),
      "the meter to notice the turn",
    );
  });

  it("does not re-ask on a roster push that billed nothing", async () => {
    // A working bench pushes the roster constantly - a status, an activity
    // line. None of that moves the ledger.
    let asked = 0;
    ui = await bootCockpit({
      rows: [row({ model: "opus" })],
      spend: () => { asked += 1; return { plan: 1, account: 0, turns: 1, estimated: 0 }; },
    });
    await ui.open("auth");
    await waitFor(() => ui.$("#open-spend"), "the spend meter");

    const before = asked;
    await ui.roster([row({ model: "opus", status: "working", detail: "editing a file" })]);
    await ui.roster([row({ model: "opus", status: "working", detail: "running tests" })]);

    expect(asked).toBe(before);
  });
});
