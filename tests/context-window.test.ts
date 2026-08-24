import { describe, it, expect } from "vitest";
import { contextFrom } from "../src/daemon/stream-codec.js";
import { contextLabel, contextTone, fractionUsed } from "../src/shared/context-window.js";

/**
 * The shape below is copied from a real `claude -p --output-format
 * stream-json` run, trimmed to the fields this reads. Everything here rests
 * on that shape being what the CLI actually emits, so it is worth saying
 * where it came from.
 */
const result = (over: Record<string, unknown> = {}) => ({
  type: "result",
  subtype: "success",
  is_error: false,
  session_id: "f321ccc0",
  usage: {
    input_tokens: 2,
    cache_creation_input_tokens: 11894,
    cache_read_input_tokens: 19336,
    output_tokens: 4,
  },
  modelUsage: {
    "claude-sonnet-5": {
      inputTokens: 2,
      outputTokens: 4,
      cacheReadInputTokens: 19336,
      cacheCreationInputTokens: 11894,
      contextWindow: 1_000_000,
    },
  },
  ...over,
});

describe("reading how full a conversation is", () => {
  it("counts the cache, because cached tokens are still in the window", () => {
    // input_tokens alone is 2. A conversation reported as two tokens is the
    // whole of the mistake this avoids.
    expect(contextFrom(result() as never)).toEqual({ used: 31_232, window: 1_000_000 });
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
