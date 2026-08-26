/**
 * @vitest-environment jsdom
 * @vitest-environment-options { "url": "http://localhost/?token=t" }
 */
import { describe, it, expect, afterEach } from "vitest";
import { bootCockpit, row, entry, type Cockpit } from "./helpers/cockpit.js";
import { waitFor } from "./helpers/wait-for.js";

/**
 * What a model costs, said before it is picked.
 *
 * The picker used to quote one number: dollars per million output tokens.
 * That is the smallest term in a specialist's bill and the one that varies
 * least - a turn re-sends its whole conversation on every tool call, so what
 * it actually spends is mostly input, and mostly cached input. These hold the
 * three prices, the estimate built from them, and the comparison that makes
 * the estimate mean something.
 */

/** A model with prices worth doing arithmetic on. */
function model(id: string, price: Partial<{
  fresh: number; cacheWrite: number; cacheRead: number; out: number;
}>, contextLength: number | null = 200_000) {
  return {
    id,
    name: `${id.split("/")[0]}: ${id.split("/")[1]}`,
    vendor: id.split("/")[0]!,
    contextLength,
    price: {
      fresh: price.fresh ?? null,
      cacheWrite: price.cacheWrite ?? null,
      cacheRead: price.cacheRead ?? null,
      out: price.out ?? null,
    },
  };
}

/** What the developer's own turns have looked like, as the daemon reports it. */
const MINE = {
  shape: { freshIn: 10_000, cacheWrite: 0, cacheRead: 100_000, out: 5_000 },
  turns: 12,
};

/** Sonnet and Kimi K3 at their real prices, which is the comparison this
 * whole feature exists to make. */
const SONNET = model("anthropic/claude-sonnet-5", { fresh: 2, cacheWrite: 2.5, cacheRead: 0.2, out: 10 });
const KIMI = model("moonshotai/kimi-k3", { fresh: 3, cacheRead: 0.3, out: 15 }, 1_048_576);
const CHEAP = model("moonshotai/kimi-k2.5", { fresh: 0.6, cacheRead: 0.1, out: 3 }, 262_144);

let ui: Cockpit;
afterEach(() => ui?.unmount());

const rowFor = (id: string) => ui.$$(`#model-dialog .model-row[data-model="${id}"]`)[0]!;
const text = (id: string, part: string) => rowFor(id).querySelector(part)!.textContent;

async function openPicker(over: Parameters<typeof bootCockpit>[0]) {
  ui = await bootCockpit(over);
  await ui.open("auth");
  await ui.click(ui.$("#composer-model"));
  await waitFor(() => ui.$("#model-dialog-search") !== null);
  return ui;
}

/** A specialist already on Sonnet through OpenRouter, so there is a baseline
 * in the catalogue to compare the rest against. */
const onSonnet = {
  rows: [row({ model: "anthropic/claude-sonnet-5" })],
  entries: [entry()],
  routerKey: { present: true, hint: "…4f2a" },
};

describe("what a turn would cost", () => {
  it("is drawn on every row, from the developer's own turns", async () => {
    await openPicker({ ...onSonnet, models: [SONNET, KIMI], turnShape: MINE });

    // 10k fresh at $2, 100k cached at $0.20, 5k out at $10 = 9¢.
    expect(text("anthropic/claude-sonnet-5", ".model-turn")).toBe("9¢");
  });

  it("says which turns it is an average of", async () => {
    await openPicker({ ...onSonnet, models: [SONNET], turnShape: MINE });

    expect(ui.$("#model-dialog-basis")!.textContent).toContain("last 12");
  });

  it("says so when it is assuming rather than measuring", async () => {
    // A bench on its first afternoon has nothing to average. An assumption a
    // developer can see is a caveat; one they cannot is a lie.
    await openPicker({ ...onSonnet, models: [SONNET] });

    expect(ui.$("#model-dialog-basis")!.textContent).toMatch(/assumed/i);
  });

  it("shows a dash rather than a figure where the price is not quoted", async () => {
    await openPicker({
      ...onSonnet,
      models: [SONNET, model("openrouter/auto", {})],
      turnShape: MINE,
    });

    expect(text("openrouter/auto", ".model-turn")).toBe("—");
  });
});

describe("comparing it to what you are on", () => {
  it("says the multiple against the model the specialist is running", async () => {
    // The finding this feature exists for: K3 reads as the alternative to
    // Sonnet and is half again the price of it for the same turn.
    await openPicker({ ...onSonnet, models: [SONNET, KIMI], turnShape: MINE });

    expect(text("moonshotai/kimi-k3", ".model-multiple")).toBe("1.5×");
  });

  it("says so plainly when there is nothing in it", async () => {
    await openPicker({ ...onSonnet, models: [SONNET], turnShape: MINE });

    expect(text("anthropic/claude-sonnet-5", ".model-multiple")).toBe("same");
  });

  it("marks a model that would actually save something", async () => {
    await openPicker({ ...onSonnet, models: [SONNET, CHEAP], turnShape: MINE });

    expect(rowFor("moonshotai/kimi-k2.5").querySelector(".model-turn")!
      .getAttribute("data-cheaper")).toBe("true");
    expect(rowFor("anthropic/claude-sonnet-5").querySelector(".model-turn")!
      .getAttribute("data-cheaper")).toBe("false");
  });

  it("compares an Anthropic alias against its own list price", async () => {
    // A specialist on the plan has no per-token price of its own, and a
    // picker with no baseline can say nothing about anything.
    await openPicker({
      rows: [row({ model: "sonnet" })],
      entries: [entry()],
      routerKey: { present: true, hint: "…4f2a" },
      models: [SONNET, KIMI],
      turnShape: MINE,
    });

    expect(text("moonshotai/kimi-k3", ".model-multiple")).toBe("1.5×");
  });
});

describe("finding the saving", () => {
  it("names the cheapest model that still holds as much", async () => {
    await openPicker({ ...onSonnet, models: [SONNET, KIMI, CHEAP], turnShape: MINE });

    const said = ui.$("#model-dialog-saving")!.textContent!;
    expect(said).toContain("kimi-k2.5");
    expect(said).toContain("200k");
  });

  it("says nothing when the model you are on is already the cheapest", async () => {
    await openPicker({ ...onSonnet, models: [SONNET, KIMI], turnShape: MINE });

    expect(ui.$("#model-dialog-saving")).toBeNull();
  });

  it("will not name one that could not hold the conversation", async () => {
    // Cheap is not the same as able, and the window is the one part of "able"
    // a price list can actually answer.
    const small = model("tiny/cheap-and-small", { fresh: 0.1, cacheRead: 0.01, out: 0.2 }, 8_000);
    await openPicker({ ...onSonnet, models: [SONNET, small], turnShape: MINE });

    expect(ui.$("#model-dialog-saving")).toBeNull();
  });
});

describe("ordering the list by price", () => {
  it("puts the cheapest first when asked", async () => {
    await openPicker({ ...onSonnet, models: [KIMI, SONNET, CHEAP], turnShape: MINE });

    await ui.click(ui.$("#model-dialog-cheapest"));

    const order = ui.$$("#model-dialog .model-row").map((el) => el.dataset.model);
    // The one it is on is pinned to the top wherever it ranks - a picker that
    // cannot show what you would be changing from is asking you to remember.
    expect(order).toEqual([
      "anthropic/claude-sonnet-5", "moonshotai/kimi-k2.5", "moonshotai/kimi-k3",
    ]);
  });

  it("sorts on the cost of a turn, not on the output price", async () => {
    // The bug this whole feature is about: a model can quote a lower output
    // price and still cost more for the work, because output is the smallest
    // term in it.
    const loudOut = model("a/cheap-out-dear-in", { fresh: 30, cacheRead: 20, out: 1 });
    const quietOut = model("b/dear-out-cheap-in", { fresh: 0.5, cacheRead: 0.05, out: 40 });
    await openPicker({ ...onSonnet, models: [loudOut, quietOut], turnShape: MINE });

    await ui.click(ui.$("#model-dialog-cheapest"));

    const order = ui.$$("#model-dialog .model-row").map((el) => el.dataset.model);
    expect(order[0]).toBe("b/dear-out-cheap-in");
  });

  it("sorts a model with no price last, never first", async () => {
    await openPicker({
      ...onSonnet,
      models: [model("openrouter/auto", {}), CHEAP],
      turnShape: MINE,
    });

    await ui.click(ui.$("#model-dialog-cheapest"));

    const order = ui.$$("#model-dialog .model-row").map((el) => el.dataset.model);
    expect(order.at(-1)).toBe("openrouter/auto");
  });

  it("goes back to best-match when switched off", async () => {
    await openPicker({ ...onSonnet, models: [KIMI, CHEAP], turnShape: MINE });

    await ui.click(ui.$("#model-dialog-cheapest"));
    await ui.click(ui.$("#model-dialog-cheapest"));

    expect(ui.$("#model-dialog-cheapest")!.getAttribute("aria-pressed")).toBe("false");
  });
});

describe("what a specialist has run up", () => {
  it("is on the header, once there is a turn in it", async () => {
    ui = await bootCockpit({
      rows: [row({ model: "opus", spend: { dollars: 1.24, turns: 9, billed: "plan" } })],
      entries: [entry()],
    });
    await ui.open("auth");

    expect(ui.$("#stage-head .badge-spend")!.textContent).toBe("$1.24");
  });

  it("says which account paid for it, because the two are not the same money", async () => {
    ui = await bootCockpit({
      rows: [row({ model: "opus", spend: { dollars: 1.24, turns: 9, billed: "plan" } })],
      entries: [entry()],
    });
    await ui.open("auth");

    expect(ui.$("#stage-head .badge-spend")!.getAttribute("title")).toContain("Claude plan");
  });

  it("is on the roster row too, where the model badge used to be", async () => {
    // "How much has this cost" is a question you scan a column for. Which
    // model it is on is not - the composer says that on every screen where
    // you could act on it.
    ui = await bootCockpit({
      rows: [row({ model: "opus", spend: { dollars: 0.42, turns: 3, billed: "account" } })],
      entries: [entry()],
    });

    expect(ui.$(".row .badge-spend")!.textContent).toBe("42¢");
    expect(ui.$(".row .badge-model")).toBeNull();
  });

  it("leaves the model on the row until there is money to show instead", async () => {
    ui = await bootCockpit({ rows: [row({ model: "opus" })], entries: [entry()] });

    expect(ui.$(".row .badge-model")!.textContent).toBe("Opus 5");
  });

  it("says nothing at all before a specialist has finished a turn", async () => {
    ui = await bootCockpit({ rows: [row({ model: "opus" })], entries: [entry()] });
    await ui.open("auth");

    expect(ui.$("#stage-head .badge-spend")).toBeNull();
  });
});
