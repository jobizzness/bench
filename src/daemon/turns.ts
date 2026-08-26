import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { averageShape, type TurnShape } from "../shared/cost.js";

/**
 * The shape of the last few turns this bench has run.
 *
 * Kept so that "what would this cost on that model" can be answered with the
 * developer's own work rather than a figure off a brochure. A turn on this
 * bench is a particular thing - a long conversation re-sent on every tool
 * call, mostly out of cache - and a model priced against a thousand-token
 * chat is priced against nothing anybody here does.
 *
 * Deliberately not in sessions.json. That file is the roster and losing it
 * loses specialists; this is a rolling sample and losing it costs nothing but
 * the accuracy of an estimate. It is written on the same pattern all the
 * same - to one side and renamed into place - because two daemons sharing a
 * home should not be able to leave half a file behind.
 */
const KEEP = 20;

export class TurnLog {
  private readonly path: string;
  private writes = 0;

  constructor(home: string) {
    this.path = join(home, "turns.json");
  }

  /** Every shape on file, oldest first. An unreadable or absent file is an
   * empty history: this is a sample, and nothing here is worth an exception. */
  async all(): Promise<TurnShape[]> {
    try {
      const raw = JSON.parse(await readFile(this.path, "utf8")) as unknown;
      if (!Array.isArray(raw)) return [];
      return raw.filter(isShape).slice(-KEEP);
    } catch {
      return [];
    }
  }

  /** Add one, drop the oldest past twenty. */
  async record(shape: TurnShape): Promise<void> {
    const kept = [...await this.all(), shape].slice(-KEEP);
    const temp = `${this.path}.${process.pid}.${++this.writes}.tmp`;
    try {
      await writeFile(temp, JSON.stringify(kept, null, 2) + "\n");
      await rename(temp, this.path);
    } catch {
      // A sample that failed to save costs an estimate a little accuracy. It
      // is not worth failing a turn over, and the turn has already happened.
    }
  }

  /**
   * The turn to price a model against, and how many real ones it came from.
   *
   * The count goes out with it because a mean of two turns is a different
   * claim from a mean of twenty, and the page that draws it has to be able to
   * say which one it is holding.
   */
  async typical(): Promise<{ shape: TurnShape | null; turns: number }> {
    const all = await this.all();
    return { shape: averageShape(all), turns: all.length };
  }
}

function isShape(value: unknown): value is TurnShape {
  const shape = value as TurnShape;
  return (
    typeof shape === "object" && shape !== null
    && ["freshIn", "cacheWrite", "cacheRead", "out"].every(
      (key) => typeof (shape as unknown as Record<string, unknown>)[key] === "number",
    )
  );
}
