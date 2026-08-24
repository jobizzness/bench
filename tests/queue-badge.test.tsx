/**
 * @vitest-environment jsdom
 */
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { BrainMark } from "../src/client/components/BrainMark.js";

describe("the brain mark", () => {
  it("draws at whatever size the caller asks for", () => {
    const html = renderToStaticMarkup(<BrainMark size={15} />);
    expect(html).toContain('width="15"');
    expect(html).toContain('height="15"');
  });

  it("keeps a 24 unit box, so every size lines up with the rest of the chrome", () => {
    expect(renderToStaticMarkup(<BrainMark />)).toContain('viewBox="0 0 24 24"');
  });

  it("takes its colour from the button it sits in", () => {
    // The badge is green because it wants you; the mark must not carry its
    // own colour or the two drift apart.
    expect(renderToStaticMarkup(<BrainMark />)).toContain('stroke="currentColor"');
  });

  it("is hidden from a screen reader, which reads the button's own label", () => {
    // The button says "3 waiting on you". A decorative mark repeating that
    // is noise in the one place it cannot be skimmed past.
    const html = renderToStaticMarkup(<BrainMark />);
    expect(html).toContain('aria-hidden="true"');
  });

  it("keeps the fold, which is what survives being small", () => {
    // Without the interior line it is a helmet at 15px.
    expect(renderToStaticMarkup(<BrainMark />)).toContain('d="M11.5 7.5v13"');
  });
});
