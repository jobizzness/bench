import { describe, it, expect } from "vitest";
import { artifactPage } from "../src/daemon/artifact-page.js";

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
    expect(page).toContain("background: #16211c");
    expect(page).toContain("color: #e8efe9");
    expect(page).toContain("color-scheme: dark");
  });

  it("puts the agent's own styles after the ground, so they win", () => {
    const page = artifactPage(`<div style="color:#111827">x</div>`);
    expect(page.indexOf("background: #16211c")).toBeLessThan(page.indexOf("#111827"));
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
});
