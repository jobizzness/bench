import { describe, it, expect, beforeEach } from "vitest";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ledger, totalOf, type Entry } from "../src/daemon/ledger.js";

/**
 * The money, kept somewhere the roster cannot delete it.
 *
 * Spend lived only on the specialist's own record, and closing a tab removes
 * that record - so the ordinary way of finishing a piece of work was also the
 * way of erasing what it cost. This file is the answer, and most of what is
 * asserted here is about surviving things rather than about arithmetic.
 */

let home: string;
beforeEach(async () => { home = await mkdtemp(join(tmpdir(), "bench-ledger-")); });

const entry = (over: Partial<Entry> = {}): Entry => ({
  at: "2026-08-27T14:00:00.000Z",
  session: "s1",
  label: "patient-speed",
  project: "/var/www/teledoctor",
  model: "opus",
  dollars: 1.5,
  billed: "plan",
  basis: "settled",
  ...over,
});

describe("writing turns down", () => {
  it("keeps a turn after the specialist that spent it is gone", async () => {
    // The whole reason this file exists. Nothing here can delete, so a closed
    // tab's spend is still answerable for.
    const ledger = new Ledger(home);
    await ledger.record(entry({ session: "closed-tab", dollars: 4.38 }));

    expect(await ledger.total()).toEqual({ plan: 4.38, account: 0, turns: 1, estimated: 0 });
  });

  it("appends rather than rewriting, so a second daemon cannot lose the first's line", async () => {
    const ledger = new Ledger(home);
    await ledger.record(entry({ session: "a" }));
    await ledger.record(entry({ session: "b" }));

    const lines = (await readFile(join(home, "spend.jsonl"), "utf8")).trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!).session).toBe("a");
  });

  it("says nothing and stays up when it cannot write", async () => {
    // A turn that has already happened cannot be un-happened by failing to
    // record it, and taking six specialists down over one line is a worse
    // trade than a total that reads a little low.
    const ledger = new Ledger(join(home, "no", "such", "place"));
    await expect(ledger.record(entry())).resolves.toBeUndefined();
  });

  it("is empty rather than broken before anything has been billed", async () => {
    expect(await new Ledger(home).all()).toEqual([]);
  });
});

describe("reading it back", () => {
  it("keeps the history when the last line was half written", async () => {
    // The one way an append-only file gets damaged. Refusing to read the
    // whole history because of it would turn a lost turn into a lost ledger.
    await writeFile(
      join(home, "spend.jsonl"),
      JSON.stringify(entry({ session: "a" })) + "\n" + '{"at":"2026-08-2',
    );

    const all = await new Ledger(home).all();
    expect(all).toHaveLength(1);
    expect(all[0]!.session).toBe("a");
  });

  it("drops a line that parses but is not a turn", async () => {
    await writeFile(
      join(home, "spend.jsonl"),
      '{"hello":"world"}\n' + JSON.stringify(entry()) + "\n",
    );

    expect(await new Ledger(home).all()).toHaveLength(1);
  });
});

describe("what it comes to", () => {
  it("never adds a subscription turn to a cash one", async () => {
    // One is a bill and the other is what a subscription would have been
    // charged if it were one. A single figure across both is true of nothing.
    const total = totalOf([
      entry({ billed: "plan", dollars: 6.44 }),
      entry({ billed: "account", dollars: 0.05 }),
    ]);

    expect(total.plan).toBeCloseTo(6.44);
    expect(total.account).toBeCloseTo(0.05);
    expect(total.turns).toBe(2);
  });

  it("says how much of the total is a guess", async () => {
    // A catalogue estimate on a proxied turn measured 1.46x under against 500
    // real requests. A total that mixes settled figures with estimates and
    // does not say so is a total nobody can act on.
    const total = totalOf([
      entry({ billed: "account", dollars: 2, basis: "settled" }),
      entry({ billed: "account", dollars: 3, basis: "estimated" }),
    ]);

    expect(total.account).toBeCloseTo(5);
    expect(total.estimated).toBeCloseTo(3);
  });

  it("totals only what it is asked about", async () => {
    const ledger = new Ledger(home);
    await ledger.record(entry({ project: "/var/www/teledoctor", dollars: 2 }));
    await ledger.record(entry({ project: "/var/www/bench", dollars: 7 }));

    const one = await ledger.total((e) => e.project === "/var/www/bench");
    expect(one.plan).toBeCloseTo(7);
    expect(one.turns).toBe(1);
  });

  it("is zero, not empty, for a bench that has billed nothing", async () => {
    expect(await new Ledger(home).total()).toEqual({ plan: 0, account: 0, turns: 0, estimated: 0 });
  });
});
