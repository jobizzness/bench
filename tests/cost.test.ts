import { describe, it, expect } from "vitest";
import {
  ASSUMED_SHAPE, averageShape, comparisonLabel, costOfTurn, costSpanOfTurn, dollars, multipleLabel,
  multipleOf, perMillionLabel, perMillionSpanLabel, promptPerRequest, rateForPrompt, turnTokens,
  type Price, type TurnShape,
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

/**
 * Charging the rate the prompt actually lands on.
 *
 * The figures are `qwen/qwen3-coder-flash` as the live catalogue quotes it
 * today, copied rather than invented, because it is this bench's own default
 * reviewer and the reason the feature exists: it costs 2.67x its headline rate
 * once a prompt passes 128k, which is an ordinary size for a reviewer sent to
 * read a whole branch.
 */
const QWEN: Price = {
  fresh: 0.195, cacheWrite: 0.24375, cacheRead: 0.039, out: 0.975,
  tiers: [
    { fromPromptTokens: 32_000, fresh: 0.325, cacheWrite: 0.40625, cacheRead: 0.065, out: 1.625 },
    { fromPromptTokens: 128_000, fresh: 0.52, cacheWrite: 0.65, cacheRead: 0.104, out: 2.6 },
  ],
};

describe("picking the rate a prompt is charged at", () => {
  it("uses the headline rate below the first tier", () => {
    expect(rateForPrompt(QWEN, 31_999)).toMatchObject({ fresh: 0.195, out: 0.975 });
    expect(rateForPrompt(QWEN, 0)).toMatchObject({ fresh: 0.195 });
  });

  it("charges the tier at exactly the size it starts", () => {
    // OpenRouter calls it `min_prompt_tokens`, and a minimum is a figure you
    // are allowed to be exactly at. One token either side of the boundary is
    // the difference between $0.195/M and $0.325/M.
    expect(rateForPrompt(QWEN, 32_000)).toMatchObject({ fresh: 0.325 });
    expect(rateForPrompt(QWEN, 128_000)).toMatchObject({ fresh: 0.52 });
  });

  it("stays on the last tier however far above it the prompt goes", () => {
    // There is no tier beyond the last, so a million-token prompt is charged
    // at the top rate rather than falling off the end back to the headline.
    expect(rateForPrompt(QWEN, 1_000_000)).toMatchObject({ fresh: 0.52, out: 2.6 });
  });

  it("takes the dearest tier the prompt has reached, not the first that fits", () => {
    expect(rateForPrompt(QWEN, 200_000)).toMatchObject({ fresh: 0.52 });
  });

  it("does not trust the tiers to arrive in order", () => {
    // The ordering is OpenRouter's to change, and a mis-sorted list should
    // charge the wrong rate never rather than quietly.
    const jumbled: Price = { ...QWEN, tiers: [QWEN.tiers![1], QWEN.tiers![0]] };

    expect(rateForPrompt(jumbled, 200_000)).toMatchObject({ fresh: 0.52 });
    expect(rateForPrompt(jumbled, 40_000)).toMatchObject({ fresh: 0.325 });
  });

  it("hands back the headline rate for a model with no tiers at all", () => {
    // Which is 359 of the 417 models in the catalogue.
    expect(rateForPrompt(SONNET, 5_000_000)).toBe(SONNET);
  });
});

describe("how big one request's prompt was", () => {
  it("is the input divided by the number of requests that carried it", () => {
    // Output is left out: it is not in the prompt.
    expect(promptPerRequest({
      freshIn: 20_000, cacheWrite: 10_000, cacheRead: 90_000, out: 8_000, requests: 10,
    })).toBe(12_000);
  });

  it("is the whole input when the turn was a single request", () => {
    expect(promptPerRequest({
      freshIn: 30_000, cacheWrite: 0, cacheRead: 2_000, out: 500, requests: 1,
    })).toBe(32_000);
  });

  it("is nothing at all when the shape did not count its requests", () => {
    // The important one. A TurnShape is a sum over every request in the turn,
    // and the sum of twenty 6k prompts is 120k - which is not a 120k prompt.
    // Reading it as one would put an ordinary turn on the top tier and
    // over-charge by about the tool-call count.
    expect(promptPerRequest(shape())).toBeNull();
  });

  it("ignores a request count that could not be one", () => {
    expect(promptPerRequest({ ...shape(), requests: 0 })).toBeNull();
    expect(promptPerRequest({ ...shape(), requests: -3 })).toBeNull();
  });
});

describe("costing a turn on a model whose price has tiers", () => {
  it("charges the headline rate for a turn of ordinary requests", () => {
    // Twenty requests averaging 6k of prompt each. The tokens sum to 120k,
    // which is over the first threshold and nowhere near a single request
    // that crossed it - so the headline rate is the right one.
    const cost = costOfTurn(
      { freshIn: 20_000, cacheWrite: 0, cacheRead: 100_000, out: 5_000, requests: 20 },
      QWEN,
    )!;
    const headline = (20_000 * 0.195 + 100_000 * 0.039 + 5_000 * 0.975) / 1_000_000;

    expect(cost).toBeCloseTo(headline, 10);
  });

  it("charges the top tier when the requests really were that big", () => {
    // The reviewer reading a whole branch: two requests, 130k of prompt each.
    const cost = costOfTurn(
      { freshIn: 60_000, cacheWrite: 0, cacheRead: 200_000, out: 4_000, requests: 2 },
      QWEN,
    )!;
    const top = (60_000 * 0.52 + 200_000 * 0.104 + 4_000 * 2.6) / 1_000_000;

    expect(cost).toBeCloseTo(top, 10);
  });

  it("is 2.67x the headline quote on the branch-sized turn, which is the whole point", () => {
    const big: TurnShape = { freshIn: 130_000, cacheWrite: 0, cacheRead: 0, out: 0, requests: 1 };

    expect(costOfTurn(big, QWEN)! / costOfTurn(big, { ...QWEN, tiers: undefined })!)
      .toBeCloseTo(2.67, 2);
  });

  it("keeps a tier rate the override did not restate", () => {
    // Real shape, from google/gemini-3.1-pro-preview: its 200k tier names a
    // new prompt, completion and cache-read price and says nothing about
    // cache-write. Silence means unchanged, not unquoted - reading it as
    // unquoted would fall back to the fresh rate and charge ten times over.
    const gemini: Price = {
      fresh: 2, cacheWrite: 0.375, cacheRead: 0.2, out: 12,
      tiers: [{ fromPromptTokens: 200_000, fresh: 4, cacheWrite: 0.375, cacheRead: 0.4, out: 18 }],
    };

    expect(costOfTurn(
      { freshIn: 0, cacheWrite: 1_000_000, cacheRead: 0, out: 0, requests: 1 },
      gemini,
    )).toBeCloseTo(0.375, 10);
  });

  it("charges the headline rate when the shape cannot say how big a request was", () => {
    // Deliberately the old answer rather than a new guess. With no request
    // count there is no prompt size to be had, and the alternative - treating
    // the turn as one request - over-charges a long turn badly.
    expect(costOfTurn(shape(), QWEN)).toBe(costOfTurn(shape(), { ...QWEN, tiers: undefined }));
  });

  it("leaves a model without tiers costing exactly what it costed before", () => {
    // The overwhelming majority of the catalogue. A request count must make no
    // difference at all to a price that has only one rate.
    for (const requests of [undefined, 1, 12]) {
      expect(costOfTurn({ ...ASSUMED_SHAPE, requests }, SONNET))
        .toBe(costOfTurn(ASSUMED_SHAPE, SONNET));
    }
  });
});

describe("a price that is a range rather than a figure", () => {
  it("spans the cheapest and dearest the same turn could come to", () => {
    const span = costSpanOfTurn(ASSUMED_SHAPE, QWEN)!;

    expect(span.low).toBeCloseTo(costOfTurn(ASSUMED_SHAPE, { ...QWEN, tiers: undefined })!, 10);
    expect(span.high / span.low).toBeCloseTo(2.67, 2);
  });

  it("is nothing at all for a model with one rate", () => {
    // Most of them. A row that says "$0.05 to $0.05" is a worse way of
    // saying $0.05.
    expect(costSpanOfTurn(ASSUMED_SHAPE, SONNET)).toBeNull();
    expect(costSpanOfTurn(ASSUMED_SHAPE, { ...QWEN, tiers: [] })).toBeNull();
  });

  it("does not let the shape's own request count narrow the span", () => {
    // The span is what the model could charge, not what this turn happened
    // to land on - so a shape that pins itself to one tier must not collapse
    // it to that tier.
    expect(costSpanOfTurn({ ...ASSUMED_SHAPE, requests: 40 }, QWEN))
      .toEqual(costSpanOfTurn(ASSUMED_SHAPE, QWEN));
  });

  it("says nothing when no end of the range was quoted", () => {
    const unquoted: Price = {
      fresh: null, cacheWrite: null, cacheRead: null, out: null,
      tiers: [{ fromPromptTokens: 32_000, fresh: null, cacheWrite: null, cacheRead: null, out: null }],
    };

    expect(costSpanOfTurn(ASSUMED_SHAPE, unquoted)).toBeNull();
  });

  it("says a range as a range, and a point as a point", () => {
    expect(perMillionSpanLabel(0.2, 0.52)).toBe("$0.20 to $0.52");
    expect(perMillionSpanLabel(3, 3)).toBe("$3");
    expect(perMillionSpanLabel(0.2, null)).toBe("$0.20");
    expect(perMillionSpanLabel(null, null)).toBe("—");
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

  it("averages the request counts too, so the mean turn can pick a tier", () => {
    const average = averageShape([
      { freshIn: 100, cacheWrite: 200, cacheRead: 300, out: 400, requests: 4 },
      { freshIn: 300, cacheWrite: 400, cacheRead: 500, out: 600, requests: 8 },
    ]);

    expect(average).toEqual({
      freshIn: 200, cacheWrite: 300, cacheRead: 400, out: 500, requests: 6,
    });
  });

  it("drops the count entirely when any turn did not carry one", () => {
    // A mean over only the turns that counted would be a request count for a
    // different set of turns than the token figures beside it, and a tier
    // picked off that is a tier picked off arithmetic nobody performed.
    const average = averageShape([
      { freshIn: 100, cacheWrite: 200, cacheRead: 300, out: 400, requests: 4 },
      { freshIn: 300, cacheWrite: 400, cacheRead: 500, out: 600 },
    ]);

    expect(average).not.toHaveProperty("requests");
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
