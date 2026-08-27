import { describe, it, expect } from "vitest";
import {
  ASSUMED_SHAPE, averageShape, comparisonLabel, costOfTurn, dollars, multipleLabel, multipleOf,
  perMillionLabel, turnTokens, type Price, type TurnShape,
} from "../src/shared/cost.js";

/**
 * The arithmetic behind "what would this turn cost on that model".
 *
 * Tested without a browser or a network on purpose: the daemon prices a turn
 * that happened and the cockpit prices one that might, and the whole point of
 * one module is that they cannot disagree.
 */

const shape = (over: Partial<TurnShape> = {}): TurnShape =>
  ({ freshIn: 10_000, cacheWrite: 0, cacheRead: 0, out: 1_000, ...over });

/** Sonnet 5 through OpenRouter, as the catalogue quoted it. */
const SONNET: Price = { fresh: 2, cacheWrite: 2.5, cacheRead: 0.2, out: 10 };
/** Kimi K3, which reads as the cheap alternative and is not one. */
const KIMI_K3: Price = { fresh: 3, cacheWrite: null, cacheRead: 0.3, out: 15 };

describe("costing a turn", () => {
  it("charges every kind of token at its own rate", () => {
    const cost = costOfTurn(
      { freshIn: 1_000_000, cacheWrite: 0, cacheRead: 0, out: 0 },
      SONNET,
    );

    expect(cost).toBe(2);
  });

  it("adds the four together", () => {
    // 1M fresh at $2, 1M written at $2.50, 1M read at $0.20, 1M out at $10.
    const cost = costOfTurn(
      { freshIn: 1_000_000, cacheWrite: 1_000_000, cacheRead: 1_000_000, out: 1_000_000 },
      SONNET,
    );

    expect(cost).toBeCloseTo(14.7, 6);
  });

  it("charges fresh for cached tokens on a model that does not quote a cache", () => {
    // Not an optimism: a model with no cache re-reads the conversation every
    // time, and the developer pays for it.
    const nocache: Price = { fresh: 1, cacheWrite: null, cacheRead: null, out: 1 };

    expect(costOfTurn({ freshIn: 0, cacheWrite: 0, cacheRead: 1_000_000, out: 0 }, nocache)).toBe(1);
  });

  it("says nothing at all when a price is not quoted", () => {
    // A total that quietly leaves out output cost looks like an answer.
    const partial: Price = { fresh: 1, cacheWrite: 1, cacheRead: 1, out: null };

    expect(costOfTurn(shape(), partial)).toBeNull();
  });

  it("is free when the model is", () => {
    const free: Price = { fresh: 0, cacheWrite: 0, cacheRead: 0, out: 0 };

    expect(costOfTurn(shape(), free)).toBe(0);
  });

  it("prices the assumed turn as something a person would recognise", () => {
    // A guard on the shape itself: if somebody edits it to nonsense, a turn
    // on Sonnet should still land in cents, not in hundreds of dollars.
    const cost = costOfTurn(ASSUMED_SHAPE, SONNET)!;

    expect(cost).toBeGreaterThan(0.01);
    expect(cost).toBeLessThan(1);
  });

  it("makes the comparison the picker exists to make", () => {
    // The whole reason for this feature: K3 looks like the alternative to
    // Sonnet and is half again the price of it.
    const k3 = costOfTurn(ASSUMED_SHAPE, KIMI_K3)!;
    const sonnet = costOfTurn(ASSUMED_SHAPE, SONNET)!;

    expect(k3 / sonnet).toBeGreaterThan(1.4);
    expect(k3 / sonnet).toBeLessThan(1.6);
  });
});

describe("the shape of a typical turn", () => {
  it("averages what actually happened", () => {
    const average = averageShape([
      { freshIn: 100, cacheWrite: 200, cacheRead: 300, out: 400 },
      { freshIn: 300, cacheWrite: 400, cacheRead: 500, out: 600 },
    ]);

    expect(average).toEqual({ freshIn: 200, cacheWrite: 300, cacheRead: 400, out: 500 });
  });

  it("is nothing at all with nothing to average", () => {
    expect(averageShape([])).toBeNull();
  });

  it("counts every token a turn moved", () => {
    expect(turnTokens({ freshIn: 1, cacheWrite: 2, cacheRead: 3, out: 4 })).toBe(10);
  });
});

describe("saying how one model compares to another", () => {
  it("is the ratio of the two", () => {
    expect(multipleOf(15, 10)).toBe(1.5);
  });

  it("says nothing against a baseline that costs nothing", () => {
    // Everything is infinitely more expensive than free, which is not a
    // sentence worth putting on a row.
    expect(multipleOf(15, 0)).toBeNull();
    expect(multipleOf(15, null)).toBeNull();
  });

  it("reads as a multiple above, and a fraction below", () => {
    expect(multipleLabel(1.5)).toBe("1.5×");
    expect(multipleLabel(12)).toBe("12×");
    expect(multipleLabel(0.25)).toBe("0.25×");
  });

  it("says free rather than nought times what you are paying", () => {
    // "0.0x what you are on" is what rounding a ratio of nought produced, and
    // it reads as a rounding error rather than as the word for it.
    expect(multipleLabel(0)).toBe("free");
  });

  it("says so plainly when there is nothing in it", () => {
    expect(multipleLabel(1)).toBe("same");
    expect(multipleLabel(0.98)).toBe("same");
  });

  it("drops the decimal when it is a whole number of times", () => {
    expect(multipleLabel(3)).toBe("3×");
  });
});

describe("saying money at the size it is", () => {
  it("uses cents where dollars would round to nothing", () => {
    expect(dollars(0.004)).toBe("0.40¢");
    expect(dollars(0.12)).toBe("12¢");
  });

  it("uses dollars once there are some", () => {
    expect(dollars(1.5)).toBe("$1.50");
  });

  it("says free rather than nought", () => {
    expect(dollars(0)).toBe("free");
  });

  it("says nothing when there is no figure", () => {
    expect(dollars(null)).toBe("");
  });

  it("quotes a catalogue price at the precision it was quoted", () => {
    expect(perMillionLabel(0.6)).toBe("$0.60");
    expect(perMillionLabel(3)).toBe("$3");
    expect(perMillionLabel(3.4)).toBe("$3.4");
    expect(perMillionLabel(15)).toBe("$15");
    expect(perMillionLabel(0)).toBe("free");
  });

  it("marks an unquoted price as unknown rather than free", () => {
    expect(perMillionLabel(null)).toBe("—");
  });
});

describe("saying the comparison the way a person would", () => {
  it("names the direction, which a bare ratio never did", () => {
    // "0.25x" and "1.5x" look alike at a glance and mean opposite things.
    expect(comparisonLabel(1.5)).toBe("1.5× dearer");
    expect(comparisonLabel(0.25)).toBe("4× cheaper");
  });

  it("drops to whole numbers once the difference is large", () => {
    expect(comparisonLabel(48)).toBe("48× dearer");
    expect(comparisonLabel(0.02)).toBe("50× cheaper");
  });

  it("calls a few per cent the same price, because it is", () => {
    // "1.02x dearer" is a difference nobody would act on, dressed as one
    // they might.
    expect(comparisonLabel(1)).toBe("about the same");
    expect(comparisonLabel(1.07)).toBe("about the same");
    expect(comparisonLabel(0.93)).toBe("about the same");
  });

  it("says free rather than an infinite saving", () => {
    expect(comparisonLabel(0)).toBe("free");
  });

  it("says nothing when there is nothing to compare", () => {
    expect(comparisonLabel(null)).toBe("");
  });
});
