import { describe, it, expect } from "vitest";
import { contextFrom } from "../src/daemon/stream-codec.js";
import { contextTone, fractionUsed } from "../src/shared/context-window.js";

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
