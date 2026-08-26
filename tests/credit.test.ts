import { describe, it, expect } from "vitest";
import { creditPercent, money, creditSummary, type Credit } from "../src/shared/credit.js";

const spent = (over: Partial<Extract<Credit, { available: true }>> = {}): Credit =>
  ({ available: true, spent: 12.4, limit: 50, ...over });

describe("how much of an OpenRouter key is gone", () => {
  it("is the spend as a fraction of the ceiling", () => {
    expect(creditPercent(spent())).toBe(25);
  });

  it("is nothing at all for a key with no ceiling", () => {
    // Pay-as-you-go, which is the common case. Inventing a percentage for it
    // would be inventing the denominator too.
    expect(creditPercent(spent({ limit: null }))).toBeNull();
  });

  it("is nothing for a ceiling of zero, rather than a division by it", () => {
    expect(creditPercent(spent({ limit: 0 }))).toBeNull();
  });

  it("stops at full for a key spent past its ceiling", () => {
    // OpenRouter keeps counting for a moment after the limit is passed. A bar
    // wider than its track is a bar with its end cut off.
    expect(creditPercent(spent({ spent: 60, limit: 50 }))).toBe(100);
  });

  it("is nothing when there is nothing to report", () => {
    expect(creditPercent({ available: false, reason: "none" })).toBeNull();
  });
});

describe("saying the money", () => {
  it("keeps two decimals even where they are round", () => {
    // Beside "$12.40", a bare "$8" does not read as the same kind of number.
    expect(money(8)).toBe("$8.00");
    expect(money(12.4)).toBe("$12.40");
  });

  it("says the spend against the ceiling when there is one", () => {
    expect(creditSummary(spent())).toBe("OpenRouter: $12.40 of $50.00 used");
  });

  it("says only the spend when there is no ceiling", () => {
    expect(creditSummary(spent({ limit: null }))).toBe("OpenRouter: $12.40 spent");
  });
});
