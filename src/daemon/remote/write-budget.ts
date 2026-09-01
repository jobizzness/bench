/**
 * What today has cost, and what that should do to the mirror's pace.
 *
 * Spark resets around midnight Pacific with no overage - see "What it costs,
 * and what happens when it runs out" in the design. The daemon keeps its own
 * count; it is only ever a count of what *this* daemon has spent, not the
 * account's true total (see the two-machines caveat in the design), which is
 * accepted rather than fixed by a shared counter that would cost the writes
 * it is trying to save.
 */

const PACIFIC = "America/Los_Angeles";

/** Today's date in the zone Spark actually resets in, regardless of what
 * timezone this process is running in. */
function pacificDay(now: number): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: PACIFIC }).format(new Date(now));
}

export interface WriteBudgetOptions {
  /** Past this many writes today, the coalescing window widens from 2s to
   * 10s. Defaults to the design's own figure. */
  widenAt?: number;
  /** Past this many, mirror writes happen only on turn boundaries - modelled
   * here as "no timed write at all", left to the caller to still write when
   * a turn actually ends. */
  restrictAt?: number;
  now?: () => number;
}

/** Returned by `cadence()`: how long a mirror write should wait, and whether
 * a timed write should happen at all. */
export interface Cadence {
  coalesceMs: number;
  /** False past `restrictAt` - only a turn boundary should write then. */
  timedWritesAllowed: boolean;
}

export class WriteBudget {
  private readonly now: () => number;
  private readonly widenAt: number;
  private readonly restrictAt: number;
  private day: string;
  private count = 0;

  constructor(opts: WriteBudgetOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.widenAt = opts.widenAt ?? 15_000;
    this.restrictAt = opts.restrictAt ?? 18_000;
    this.day = pacificDay(this.now());
  }

  private rollIfNewDay(): void {
    const today = pacificDay(this.now());
    if (today !== this.day) {
      this.day = today;
      this.count = 0;
    }
  }

  /** Call once per Firestore write actually made. */
  record(writes = 1): void {
    this.rollIfNewDay();
    this.count += writes;
  }

  spentToday(): number {
    this.rollIfNewDay();
    return this.count;
  }

  /** Whether the cockpit should say it is slowing down. Widened cadence and
   * "degraded" are the same threshold - there is nothing to see past 2s that
   * is not already true at 15,000 writes. */
  degraded(): boolean {
    return this.spentToday() >= this.widenAt;
  }

  cadence(baseMs: number): Cadence {
    const spent = this.spentToday();
    if (spent >= this.restrictAt) return { coalesceMs: baseMs, timedWritesAllowed: false };
    if (spent >= this.widenAt) return { coalesceMs: 10_000, timedWritesAllowed: true };
    return { coalesceMs: baseMs, timedWritesAllowed: true };
  }
}
