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

  it("reads used tokens and context window from Claude result event", () => {
    const ctx = contextFrom(result() as any);
    expect(ctx).not.toBeNull();
    expect(ctx?.used).toBe(26_203);
    expect(ctx?.window).toBe(1_000_000);
    expect(contextTone(ctx)).toBe("ok");
    expect(fractionUsed(ctx)).toBeCloseTo(0.0262, 3);
  });

  it("resolves actual context window for Gemini models run through proxy (#171)", () => {
    // Gemini 3.7 Flash has 1M window (1048576)
    const flashResult = result({
      usage: {
        input_tokens: 1500,
        output_tokens: 50,
        cache_read_input_tokens: 200,
      },
      modelUsage: {
        "google/gemini-3.7-flash": {
          inputTokens: 1500,
          outputTokens: 50,
          // Claude Code CLI lacks native window for proxied models, reports 0 or default
          contextWindow: 0,
        },
      },
    });

    const flashCtx = contextFrom(flashResult as any);
    expect(flashCtx).not.toBeNull();
    expect(flashCtx?.used).toBe(1700);
    expect(flashCtx?.window).toBe(1_048_576);
    expect(contextTone(flashCtx)).toBe("ok");
    expect(fractionUsed(flashCtx)! < 0.10).toBe(true);

    // Gemini 2.5 Pro has 2M window (2097152)
    const proResult = result({
      usage: {
        input_tokens: 2500,
        output_tokens: 80,
      },
      modelUsage: {
        "google/gemini-2.5-pro": {
          inputTokens: 2500,
          outputTokens: 80,
          contextWindow: 200_000, // Even if Claude CLI defaulted to Anthropic 200k
        },
      },
    });

    const proCtx = contextFrom(proResult as any);
    expect(proCtx).not.toBeNull();
    expect(proCtx?.used).toBe(2500);
    expect(proCtx?.window).toBe(2_097_152);
    expect(contextTone(proCtx)).toBe("ok");
    expect(fractionUsed(proCtx)! < 0.10).toBe(true);
  });

  it("falls back to top-level usage and fallbackWindow when iterations or models are omitted (#171)", () => {
    const proxiedEvent = {
      type: "result",
      subtype: "success",
      is_error: false,
      session_id: "gem-123",
      usage: {
        input_tokens: 1200,
        output_tokens: 40,
        cache_read_input_tokens: 100,
      },
    };

    const ctx = contextFrom(proxiedEvent as any, 1_048_576);
    expect(ctx).not.toBeNull();
    expect(ctx?.used).toBe(1300);
    expect(ctx?.window).toBe(1_048_576);
    expect(contextTone(ctx)).toBe("ok");
    expect(fractionUsed(ctx)! < 0.10).toBe(true);
  });
});
