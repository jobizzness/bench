import { describe, it, expect } from "vitest";
import { WriteBudget } from "../src/daemon/remote/write-budget.js";

const NOON_PACIFIC_UTC = Date.parse("2026-09-01T19:00:00Z"); // 12:00 PDT (UTC-7 in September)

describe("WriteBudget", () => {
  it("starts at the normal 2s cadence with nothing spent", () => {
    const budget = new WriteBudget({ now: () => NOON_PACIFIC_UTC });
    expect(budget.spentToday()).toBe(0);
    expect(budget.degraded()).toBe(false);
    expect(budget.cadence(2000)).toEqual({ coalesceMs: 2000, timedWritesAllowed: true });
  });

  it("widens to 10s past 15,000 writes and says it is degraded", () => {
    const budget = new WriteBudget({ now: () => NOON_PACIFIC_UTC });
    budget.record(15_000);
    expect(budget.degraded()).toBe(true);
    expect(budget.cadence(2000)).toEqual({ coalesceMs: 10_000, timedWritesAllowed: true });
  });

  it("stops timed writes past 18,000, leaving only turn boundaries", () => {
    const budget = new WriteBudget({ now: () => NOON_PACIFIC_UTC });
    budget.record(18_000);
    expect(budget.cadence(2000).timedWritesAllowed).toBe(false);
  });

  it("resets at Pacific midnight, not local midnight", () => {
    let clock = Date.parse("2026-09-01T23:00:00Z"); // 16:00 PDT, day 1
    const budget = new WriteBudget({ now: () => clock });
    budget.record(19_000);
    expect(budget.degraded()).toBe(true);

    // 06:59 UTC the next calendar day is still 23:59 PDT - the same Pacific
    // day, and the count must not have reset yet.
    clock = Date.parse("2026-09-02T06:59:00Z");
    expect(budget.degraded()).toBe(true);

    // 07:01 UTC crosses into 00:01 PDT - a new Pacific day.
    clock = Date.parse("2026-09-02T07:01:00Z");
    expect(budget.spentToday()).toBe(0);
    expect(budget.degraded()).toBe(false);
  });

  it("accumulates across several record() calls", () => {
    const budget = new WriteBudget({ now: () => NOON_PACIFIC_UTC });
    for (let i = 0; i < 100; i++) budget.record();
    expect(budget.spentToday()).toBe(100);
  });
});
