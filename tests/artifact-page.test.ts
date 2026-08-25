import { describe, it, expect } from "vitest";
import { artifactPage } from "../src/daemon/artifact-page.js";
import { DEFAULT_THEME, THEMES } from "../src/shared/themes.js";

describe("artifactPage", () => {
  it("gives a fragment a document to live in", () => {
    const page = artifactPage("<h1>Done</h1>");
    expect(page.startsWith("<!doctype html>")).toBe(true);
    expect(page).toContain("<h1>Done</h1>");
  });

  it("supplies the ground a fragment cannot", () => {
    // A report with no styles rendered as black on the cockpit's dark
    // background, which is what "it has no styles" looked like.
    const page = artifactPage("<p>x</p>");
    expect(page).toContain("--ground: var(--raised)");
    expect(page).toContain("color-scheme");
    // Not a value of its own. The frame's names alias the cockpit's, and the
    // cockpit's arrive with the palette above them, so there is one place a
    // colour is written down and it is the stylesheet.
    expect(page).toContain('[data-theme="bench"]');
    expect(page).toMatch(/--text:\s*#dfe8e2/);
  });

  it("puts the agent's own styles after the ground, so they win", () => {
    const page = artifactPage(`<div style="color:#111827">x</div>`);
    expect(page.indexOf("--ground: var(--raised)")).toBeLessThan(page.indexOf("#111827"));
  });

  it("keeps the fragment exactly as written", () => {
    // It is rendered under a strict CSP in a sandboxed frame; rewriting it
    // here would be a second place for a mistake to live.
    const fragment = `<p>a & b <script>alert(1)</script></p>`;
    expect(artifactPage(fragment)).toContain(fragment);
  });

  it("survives an empty report", () => {
    expect(artifactPage("")).toContain("<body></body>");
  });

  it("caps the measure, so prose does not run the width of the window", () => {
    expect(artifactPage("<p>x</p>")).toMatch(/max-width:\s*68ch/);
  });

  it("gives the unverified list the weight, not the verified one", () => {
    // An empty "not verified" is almost always a lie, so it is the section
    // worth reading and the only one that gets a second colour.
    const page = artifactPage("<p>x</p>");
    expect(page).toContain('[data-bench="unverified"]');
    expect(page).toContain("--unverified: var(--busy)");
  });
});

/**
 * A report is a separate document in a sandboxed frame, so nothing cascades
 * into it. The theme has to arrive with the page or the frame stays dark on
 * every one of them, which is what it did.
 */
describe("the theme a report is drawn in", () => {
  it("carries every palette, so the frame needs no copy of its own", () => {
    const page = artifactPage("<p>x</p>");
    for (const id of THEMES) {
      expect(page).toContain(`[data-theme="${id.id}"]`);
    }
  });

  it("is set on the document, from the cockpit that asked", () => {
    expect(artifactPage("<p>x</p>", "paper")).toContain('<html lang="en" data-theme="paper"');
    expect(artifactPage("<p>x</p>", "ink")).toContain('data-theme="ink"');
  });

  it("falls back rather than writing an unknown name into the markup", () => {
    // The value is client-supplied and lands in an attribute. The only safe
    // list is the one the stylesheet has blocks for.
    for (const nasty of ['" onload="x', "solarized", "", undefined]) {
      expect(artifactPage("<p>x</p>", nasty)).toContain(`data-theme="${DEFAULT_THEME}"`);
    }
  });

  it("defaults for a shared link, which is read away from any cockpit", () => {
    expect(artifactPage("<p>x</p>")).toContain(`data-theme="${DEFAULT_THEME}"`);
  });

  it("leaves the cockpit's own furniture behind", () => {
    // The figure mask is eight kilobytes of contour on every report served,
    // for a ground the report does not have.
    expect(artifactPage("<p>x</p>")).not.toContain("figure-mask");
  });
});
