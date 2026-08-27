import { describe, it, expect } from "vitest";
import {
  balancePercent, creditPercent, limitPercent, money, creditSummary, type Credit,
} from "../src/shared/credit.js";

const spent = (over: Partial<Extract<Credit, { available: true }>> = {}): Credit =>
  ({ available: true, spent: 12.4, limit: 50, balance: null, ...over });

/** The live account this was written for: pay-as-you-go, so no limit at all,
 * and $1.01 of a $50 top-up left. */
const nearlyOut = spent({
  spent: 48.99,
  limit: null,
  balance: { purchased: 50, remaining: 1.012694569 },
});

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

/**
 * The other ceiling, and the one that was missing.
 *
 * A key's limit and the account's purchased credit are separate facts. The
 * meter used to know only the first, so an account with no limit and a dollar
 * on it drew no bar at all and said there was no ceiling to draw one against.
 */
describe("how much of the purchased credit is gone", () => {
  it("is what has been drawn down, as a fraction of what was bought", () => {
    expect(balancePercent(nearlyOut)).toBe(98);
  });

  it("carries the key with no ceiling anyway, which is the case that was blind", () => {
    // No limit, so nothing to be a fraction of - and yet 98% of the money is
    // gone. The bar is drawn against the balance instead.
    expect(limitPercent(nearlyOut)).toBeNull();
    expect(creditPercent(nearlyOut)).toBe(98);
  });

  it("is nothing when the balance was not known", () => {
    // /credits could not be asked. Not knowing is not the same as full.
    expect(balancePercent(spent({ limit: null }))).toBeNull();
    expect(creditPercent(spent({ limit: null }))).toBeNull();
  });

  it("is nothing for an account that has bought nothing, rather than a division by it", () => {
    expect(balancePercent(spent({ balance: { purchased: 0, remaining: 0 } }))).toBeNull();
  });

  it("stops at full for an account spent past its credit", () => {
    // OpenRouter keeps counting for a moment after the money runs out.
    expect(balancePercent(spent({ balance: { purchased: 50, remaining: -0.4 } }))).toBe(100);
  });

  it("carries whichever ceiling is nearer to stopping the work", () => {
    // Both set, and they disagree: the key is nearly at its own cap while the
    // account is barely touched. The mark is one number, and it has to be the
    // one that stops the next turn.
    const both = spent({ spent: 9, limit: 10, balance: { purchased: 50, remaining: 45 } });

    expect(limitPercent(both)).toBe(90);
    expect(balancePercent(both)).toBe(10);
    expect(creditPercent(both)).toBe(90);
  });

  it("carries the balance when that is the nearer one", () => {
    const both = spent({ spent: 1, limit: 10, balance: { purchased: 50, remaining: 1 } });

    expect(creditPercent(both)).toBe(98);
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

  it("says what is left when the balance is known", () => {
    // The line this account used to get was "$48.99 spent", which is a true
    // number that hides the only one worth acting on.
    expect(creditSummary(nearlyOut)).toBe("OpenRouter: $1.01 left of $50.00");
  });

  it("leads with what is left even where the key has a limit too", () => {
    const both = spent({ spent: 9, limit: 10, balance: { purchased: 50, remaining: 45 } });

    expect(creditSummary(both)).toBe("OpenRouter: $45.00 left of $50.00");
  });
});
