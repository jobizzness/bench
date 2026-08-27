import { appendFile, readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Every turn this bench has paid for, kept for good.
 *
 * Spend used to live in one place only - the `spend` field on a specialist's
 * record in the index - and that field is deleted along with the record when
 * a tab is closed. Closing is the normal end of a specialist's life, so the
 * ordinary course of using Bench was to spend money and then erase the fact.
 * On this machine that had already happened to seven tabs.
 *
 * Append-only, and a separate file from the index on purpose. The index is
 * the roster: it is rewritten whole every time anything changes, and losing
 * it loses specialists. This is the money, it is only ever added to, and a
 * crash halfway through costs at most the line being written rather than the
 * history. It also means no lock: a line under the size of a pipe buffer
 * arrives whole even when two daemons share a home, which is the failure that
 * produced `sessions.json.corrupt-1144`.
 *
 * Nothing here deletes. A ledger you can edit is a ledger that cannot answer
 * "what has this project cost me", which is the only question it exists for.
 */

/** What one finished turn cost, and enough about it to ask questions later. */
export interface Entry {
  /** ISO time the turn was billed. */
  at: string;
  /** The specialist. Kept even though it may since have been closed - that
   * is the whole point of writing this down somewhere else. */
  session: string;
  /** What it was called at the time. A closed tab has no other name left. */
  label: string;
  project: string;
  /** The model as Bench asked for it. Under an auto router this is
   * `openrouter/auto`, which is not what answered - see `served`. */
  model: string;
  /** What actually answered, where that is known and differs. Only OpenRouter
   * can tell us this, and only per request. */
  served?: string[];
  dollars: number;
  /** Which money. A plan turn is a subscription already paid for, quoted at
   * list price; an account turn is cash. They must never be added together. */
  billed: "plan" | "account";
  /**
   * Whether `dollars` is what was actually charged or what Bench thinks it
   * would be.
   *
   * The distinction is the reason this field exists rather than being assumed.
   * A catalogue estimate on an OpenRouter turn was measured against 500 real
   * requests and came out 1.46x under, because the catalogue quotes one
   * provider and the bill comes from whichever one served the request. A total
   * that silently mixes settled figures with estimates is a total nobody can
   * act on.
   */
  basis: "settled" | "estimated";
}

/** What a set of entries comes to, kept apart by which money paid for it. */
export interface Total {
  plan: number;
  account: number;
  turns: number;
  /** Dollars within the two above that are estimates rather than settled. */
  estimated: number;
}

export class Ledger {
  private readonly path: string;

  constructor(home: string) {
    this.path = join(home, "spend.jsonl");
  }

  /**
   * Write one turn down.
   *
   * Never throws. A turn that has already happened cannot be un-happened by
   * failing to record it, and taking the daemon down over a failed append
   * would cost the developer far more than the line is worth. The caller is
   * told nothing because there is nothing it could usefully do; the loss
   * shows up as a total that is a little low, which is the same failure mode
   * the ledger already tolerates for a crash mid-write.
   */
  async record(entry: Entry): Promise<void> {
    try {
      await appendFile(this.path, JSON.stringify(entry) + "\n");
    } catch {
      // Deliberately silent. See above.
    }
  }

  /**
   * Everything on file, oldest first.
   *
   * A line that will not parse is skipped rather than thrown over: the one
   * way this file can be damaged is a partial write at the end, and refusing
   * to read the other nine hundred lines because of it would turn a lost
   * turn into a lost history.
   */
  async all(): Promise<Entry[]> {
    let raw: string;
    try {
      raw = await readFile(this.path, "utf8");
    } catch {
      // No ledger yet is an empty one. A bench that has never billed a turn
      // is not a bench with a problem.
      return [];
    }

    const entries: Entry[] = [];
    for (const line of raw.split("\n")) {
      if (line.trim() === "") continue;
      try {
        const parsed = JSON.parse(line) as unknown;
        if (isEntry(parsed)) entries.push(parsed);
      } catch {
        // A half-written last line. Skip it and keep the rest.
      }
    }
    return entries;
  }

  /** What these entries come to. Exported as a function rather than a method
   * so the cockpit can total a filtered set without another read. */
  async total(where?: (entry: Entry) => boolean): Promise<Total> {
    return totalOf(where ? (await this.all()).filter(where) : await this.all());
  }
}

/**
 * The sum, with the two kinds of money kept apart.
 *
 * Adding a plan turn to an account turn produces a number that is true of
 * nothing: one is a bill and the other is what a subscription would have been
 * charged if it were one. The cockpit has always drawn them separately and
 * this keeps it able to.
 */
export function totalOf(entries: readonly Entry[]): Total {
  return entries.reduce<Total>(
    (sum, entry) => ({
      plan: sum.plan + (entry.billed === "plan" ? entry.dollars : 0),
      account: sum.account + (entry.billed === "account" ? entry.dollars : 0),
      turns: sum.turns + 1,
      estimated: sum.estimated + (entry.basis === "estimated" ? entry.dollars : 0),
    }),
    { plan: 0, account: 0, turns: 0, estimated: 0 },
  );
}

function isEntry(value: unknown): value is Entry {
  const entry = value as Entry;
  return (
    typeof entry === "object" && entry !== null
    && typeof entry.at === "string"
    && typeof entry.session === "string"
    && typeof entry.dollars === "number" && Number.isFinite(entry.dollars)
    && (entry.billed === "plan" || entry.billed === "account")
    && (entry.basis === "settled" || entry.basis === "estimated")
  );
}
