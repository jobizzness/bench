import { describe, it, expect } from "vitest";
import { nudgeFor, NUDGE_SPEND_THRESHOLD } from "../src/shared/nudge.js";
import type { Spend } from "../src/shared/types.js";

const spend = (dollars: number): Spend => ({ dollars, turns: 1, billed: "account" });

describe("what to tell a specialist about its own context and spend", () => {
  it("says nothing below three quarters and below the spend threshold", () => {
    expect(nudgeFor({ used: 100, window: 1000 }, spend(0.01), {})).toBeNull();
    expect(nudgeFor(null, null, {})).toBeNull();
  });

  it("nudges once on crossing into high, and not again for the same tone", () => {
    const first = nudgeFor({ used: 800, window: 1000 }, null, {});
    expect(first).not.toBeNull();
    expect(first!.text).toContain("80%");
    expect(first!.state.context).toBe("high");

    // Told once - the same tone a turn later says nothing new.
    const again = nudgeFor({ used: 850, window: 1000 }, null, first!.state);
    expect(again).toBeNull();
  });

  it("nudges again on crossing from high into full", () => {
    const state = { context: "high" as const };
    const result = nudgeFor({ used: 950, window: 1000 }, null, state);
    expect(result).not.toBeNull();
    expect(result!.text).toContain("95%");
    expect(result!.state.context).toBe("full");
  });

  it("never nudges backwards when context tone drops after a clear", () => {
    // A cleared conversation starts again at "ok" - state carries the old
    // high-water mark until a fresh crossing earns a fresh word about it.
    const state = { context: "full" as const };
    expect(nudgeFor({ used: 10, window: 1000 }, null, state)).toBeNull();
  });

  it("nudges once when cumulative spend crosses the threshold", () => {
    const result = nudgeFor(null, spend(NUDGE_SPEND_THRESHOLD), {});
    expect(result).not.toBeNull();
    expect(result!.text).toContain(`$${NUDGE_SPEND_THRESHOLD.toFixed(2)}`);
    expect(result!.state.spend).toBe(true);

    const again = nudgeFor(null, spend(NUDGE_SPEND_THRESHOLD + 5), result!.state);
    expect(again).toBeNull();
  });

  it("can say both in one turn", () => {
    const result = nudgeFor({ used: 950, window: 1000 }, spend(NUDGE_SPEND_THRESHOLD), {});
    expect(result).not.toBeNull();
    expect(result!.text).toContain("95%");
    expect(result!.text).toContain("$");
    expect(result!.state).toEqual({ context: "full", spend: true });
  });
});
