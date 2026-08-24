import { describe, it, expect } from "vitest";
import { contextFrom } from "../src/daemon/stream-codec.js";
import { contextLabel, contextTone, fractionUsed } from "../src/shared/context-window.js";

/**
 * The shape below is copied from a real `claude -p --output-format
 * stream-json` run. It keeps `iterations`, which an earlier trim of this
 * fixture dropped - and dropping it is how the number came to be wrong:
 * without it the only thing left to read was the turn total.
 *
 * `usage` at the top level is every request the turn made, added together. A
 * turn with sixty tool calls re-sends the conversation sixty times, so that
 * total is sixty conversations. `iterations` is the per-request breakdown,
 * and its last entry is the state the turn ended in.
 */
const result = (over: Record<string, unknown> = {}) => ({
  type: "result",
  subtype: "success",
  is_error: false,
  session_id: "f321ccc0",
  usage: {
    // The turn total: four requests' worth, which is not a conversation.
    input_tokens: 18,
    cache_creation_input_tokens: 11_697,
    cache_read_input_tokens: 38_036,
    output_tokens: 346,
    iterations: [
      { input_tokens: 8, cache_creation_input_tokens: 2_657, cache_read_input_tokens: 20_000 },
      { input_tokens: 8, cache_creation_input_tokens: 2_657, cache_read_input_tokens: 23_538 },
    ],
  },
  modelUsage: {
    "claude-sonnet-5": {
      inputTokens: 18,
      outputTokens: 346,
      cacheReadInputTokens: 38_036,
      cacheCreationInputTokens: 11_697,
      contextWindow: 1_000_000,
    },
  },
  ...over,
});

describe("reading how full a conversation is", () => {
  it("counts the cache, because cached tokens are still in the window", () => {
    // input_tokens alone is 8. A conversation reported as eight tokens is one
    // mistake; the turn total is the other.
    expect(contextFrom(result() as never)).toEqual({ used: 26_203, window: 1_000_000 });
  });

  it("does not add up every request the turn made", () => {
    // The bug this replaces. Summing the top-level usage gives 49,751 for a
    // conversation of 26,203 - and on a long turn it runs past the window and
    // sits at a hundred per cent, which is what the developer kept seeing.
    const used = contextFrom(result() as never)!.used;
    expect(used).toBe(26_203);
    expect(used).toBeLessThan(18 + 11_697 + 38_036);
  });

  it("grows with the conversation, not with how hard the turn worked", () => {
    // Two turns of the same conversation, the second having done far more
    // work. What it occupies has barely moved, and the number must not.
    const quiet = contextFrom(result() as never)!.used;
    const busy = contextFrom(result({
      usage: {
        input_tokens: 60, cache_creation_input_tokens: 90_000,
        cache_read_input_tokens: 900_000, output_tokens: 4_000,
        iterations: [
          { input_tokens: 8, cache_creation_input_tokens: 2_657, cache_read_input_tokens: 23_538 },
          { input_tokens: 8, cache_creation_input_tokens: 161, cache_read_input_tokens: 26_374 },
        ],
      },
    }) as never)!.used;

    expect(busy).toBe(26_543);
    expect(busy - quiet).toBeLessThan(1_000);
  });

  it("says nothing when the CLI does not break the turn down", () => {
    // An older CLI with no iterations. Nothing is better than a number that
    // is wrong in the direction of alarming.
    const flat = result({ usage: { input_tokens: 18, cache_read_input_tokens: 38_036 } });
    expect(contextFrom(flat as never)).toBeNull();
  });

  it("takes the window from the CLI rather than from a table of ours", () => {
    const smaller = result({
      modelUsage: {
        "claude-opus-5": {
          inputTokens: 10, cacheReadInputTokens: 90, cacheCreationInputTokens: 0,
          contextWindow: 200_000,
        },
      },
    });

    expect(contextFrom(smaller as never)?.window).toBe(200_000);
  });

  it("belongs to whichever model did the most work", () => {
    // A subagent on a cheaper model should not shrink the number.
    const mixed = result({
      modelUsage: {
        "claude-haiku-4-5": {
          inputTokens: 5, cacheReadInputTokens: 0, cacheCreationInputTokens: 0,
          contextWindow: 200_000,
        },
        "claude-sonnet-5": {
          inputTokens: 2, cacheReadInputTokens: 19336, cacheCreationInputTokens: 11894,
          contextWindow: 1_000_000,
        },
      },
    });

    expect(contextFrom(mixed as never)?.window).toBe(1_000_000);
  });

  it("says nothing rather than guessing when the fields are not there", () => {
    // An older CLI, or an error result. Half a number is worse than none.
    expect(contextFrom(result({ modelUsage: undefined }) as never)).toBeNull();
    expect(contextFrom(result({ usage: undefined }) as never)).toBeNull();
    expect(contextFrom({ type: "assistant" } as never)).toBeNull();
  });
});

describe("what it says about itself", () => {
  it("rounds down, so it never claims full while there is room", () => {
    expect(contextLabel({ used: 199_999, window: 200_000 })).toBe("99% context");
    expect(contextLabel({ used: 31_232, window: 1_000_000 })).toBe("3% context");
    expect(contextLabel(null)).toBeNull();
  });

  it("is quiet until three quarters, then says so", () => {
    // A cockpit that colours every fact has no colour left for the one that
    // counts.
    expect(contextTone({ used: 100, window: 1000 })).toBe("ok");
    expect(contextTone({ used: 749, window: 1000 })).toBe("ok");
    expect(contextTone({ used: 750, window: 1000 })).toBe("high");
    expect(contextTone({ used: 900, window: 1000 })).toBe("full");
  });

  it("cannot go past full, whatever it is handed", () => {
    expect(fractionUsed({ used: 2_000, window: 1_000 })).toBe(1);
    expect(fractionUsed({ used: 10, window: 0 })).toBeNull();
  });
});
