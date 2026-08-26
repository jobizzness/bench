import { describe, it, expect, beforeEach } from "vitest";
import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TurnLog } from "../src/daemon/turns.js";
import { shapeFrom, costFrom } from "../src/daemon/stream-codec.js";
import type { TurnShape } from "../src/shared/cost.js";

/**
 * The record of what turns on this bench actually look like.
 *
 * It exists so that "what would this cost on that model" is a claim about the
 * developer's own work rather than about a brochure figure. A specialist's
 * turn is a long conversation re-sent on every tool call; a model priced
 * against a thousand-token chat is priced against nothing anybody does here.
 */

const shape = (n: number): TurnShape =>
  ({ freshIn: n, cacheWrite: n * 2, cacheRead: n * 3, out: n * 4 });

let home: string;
beforeEach(async () => { home = await mkdtemp(join(tmpdir(), "bench-turns-")); });

describe("reading a turn off the result event", () => {
  /** The CLI's own event, as far as anything here cares. */
  const result = (usage: unknown, cost?: number) => ({
    type: "result" as const, subtype: "success", is_error: false, session_id: "s",
    usage, total_cost_usd: cost,
  });

  it("takes the whole turn, not the last request in it", () => {
    // A turn with sixty tool calls re-sent the conversation sixty times and
    // was charged for all sixty. The context meter wants the opposite reading
    // of the same event - what the conversation now occupies - which is why
    // these are two functions and not one.
    const event = result({
      input_tokens: 900, cache_creation_input_tokens: 100,
      cache_read_input_tokens: 40_000, output_tokens: 2_000,
      iterations: [{ input_tokens: 5, output_tokens: 5 }],
    });

    expect(shapeFrom(event as never)).toEqual({
      freshIn: 900, cacheWrite: 100, cacheRead: 40_000, out: 2_000,
    });
  });

  it("adds the requests up when the event does not total them itself", () => {
    const event = result({
      iterations: [
        { input_tokens: 10, cache_read_input_tokens: 100, output_tokens: 1 },
        { input_tokens: 20, cache_read_input_tokens: 200, output_tokens: 2 },
      ],
    });

    expect(shapeFrom(event as never)).toEqual({
      freshIn: 30, cacheWrite: 0, cacheRead: 300, out: 3,
    });
  });

  it("says nothing for a turn that reported no usage at all", () => {
    expect(shapeFrom(result(undefined) as never)).toBeNull();
    expect(shapeFrom({ type: "assistant", message: { content: [] } } as never)).toBeNull();
  });

  it("reads what the CLI says the turn cost", () => {
    expect(costFrom(result({ input_tokens: 1 }, 0.0413) as never)).toBe(0.0413);
  });

  it("refuses a cost that is not a number, rather than recording nonsense", () => {
    expect(costFrom(result({ input_tokens: 1 }) as never)).toBeNull();
    expect(costFrom(result({ input_tokens: 1 }, -2) as never)).toBeNull();
  });
});

describe("the rolling record of turns", () => {
  it("keeps what it is given, oldest first", async () => {
    const log = new TurnLog(home);
    await log.record(shape(1));
    await log.record(shape(2));

    expect(await log.all()).toEqual([shape(1), shape(2)]);
  });

  it("keeps twenty and no more, so an old afternoon stops counting", async () => {
    const log = new TurnLog(home);
    for (let i = 1; i <= 25; i++) await log.record(shape(i));

    const all = await log.all();
    expect(all).toHaveLength(20);
    expect(all[0]).toEqual(shape(6));
  });

  it("averages them into the turn every model is priced against", async () => {
    const log = new TurnLog(home);
    await log.record(shape(10));
    await log.record(shape(20));

    expect(await log.typical()).toEqual({
      shape: { freshIn: 15, cacheWrite: 30, cacheRead: 45, out: 60 },
      turns: 2,
    });
  });

  it("says it has nothing rather than averaging no turns", async () => {
    expect(await new TurnLog(home).typical()).toEqual({ shape: null, turns: 0 });
  });

  it("shrugs off a file that is not a list of turns", async () => {
    // This is a sample, not the roster. Losing it costs an estimate a little
    // accuracy and nothing else, so nothing here is worth an exception.
    await writeFile(join(home, "turns.json"), "{ not json");

    expect(await new TurnLog(home).all()).toEqual([]);
  });

  it("drops an entry that is not a turn, and keeps the ones that are", async () => {
    await writeFile(join(home, "turns.json"), JSON.stringify([shape(1), { nonsense: true }, shape(2)]));

    expect(await new TurnLog(home).all()).toEqual([shape(1), shape(2)]);
  });

  it("writes to one side and renames, so a reader never sees half a file", async () => {
    const log = new TurnLog(home);
    await log.record(shape(1));

    // Whole and parseable the moment it exists, which is what the rename buys.
    expect(JSON.parse(await readFile(join(home, "turns.json"), "utf8"))).toEqual([shape(1)]);
  });
});
