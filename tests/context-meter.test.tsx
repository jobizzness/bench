/**
 * @vitest-environment jsdom
 */
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ContextMeter } from "../src/client/components/ContextMeter.js";

const html = (used: number, window = 200_000) =>
  renderToStaticMarkup(<ContextMeter context={{ used, window }} />);

/** The fill arc's length, which is the whole of what this draws. */
function arc(markup: string): number {
  const match = /stroke-dasharray="([\d.]+)/.exec(markup);
  return match ? Number(match[1]) : -1;
}

const FULL_RING = 2 * Math.PI * 6;

describe("the context ring", () => {
  it("fills in proportion to what is used", () => {
    expect(arc(html(100_000))).toBeCloseTo(FULL_RING / 2, 1);
  });

  it("is nearly empty early and nearly closed late", () => {
    expect(arc(html(20_000))).toBeLessThan(FULL_RING * 0.15);
    expect(arc(html(190_000))).toBeGreaterThan(FULL_RING * 0.9);
  });

  it("puts the number on the hover, where an exact one belongs", () => {
    // The line under a specialist's name already carries three facts. A
    // fourth as a sentence is one to read; a dial is one to glance at.
    expect(html(150_000)).toContain('title="75% of the conversation used"');
  });

  it("says the same thing to a screen reader, which cannot see a ring", () => {
    expect(html(150_000)).toContain('aria-label="75% of the conversation used"');
  });

  it("carries the tone, so late reads differently from early", () => {
    expect(html(20_000)).toContain('data-tone="ok"');
    expect(html(160_000)).toContain('data-tone="high"');
    expect(html(190_000)).toContain('data-tone="full"');
  });

  it("draws nothing for a specialist that has never taken a turn", () => {
    // Better to say nothing than to draw an empty dial, which reads as a
    // measurement of zero rather than as no measurement.
    expect(renderToStaticMarkup(<ContextMeter context={null} />)).toBe("");
  });

  it("never overflows the ring when a conversation is over its window", () => {
    expect(arc(html(400_000))).toBeCloseTo(FULL_RING, 1);
  });
});
