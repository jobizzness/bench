import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * A modal that scrolls twice.
 *
 * The settings sheet grew two scrollbars side by side: one that moved the
 * form and one that moved nothing. A dialog gets `overflow: auto` from the
 * browser, and the form inside carried the same `max-height: 88vh` as the
 * sheet around it - so the dialog's own box was two pixels shorter than its
 * content, the width of its border, and it put up a bar to scroll them.
 *
 * jsdom has no layout, so it cannot see this: `scrollHeight` there is always
 * zero and both versions pass. What can be held is the arrangement that
 * caused it, which is what these do. The proof is a screenshot; this is the
 * tripwire.
 */
const css = readFileSync(join(process.cwd(), "src", "client", "styles.css"), "utf8");

/** The declarations of one rule, by exact selector. */
function rule(selector: string): string {
  const match = css.match(new RegExp(`(?:^|\\n)${selector.replace(/[.*+?^$()|[\]\\]/g, "\\$&")}\\s*\\{([^}]*)\\}`));
  if (!match) throw new Error(`no rule for ${selector}`);
  return match[1];
}

describe("a sheet scrolls in one place", () => {
  it("caps the sheet, not the form inside it", () => {
    // Both carrying the cap is the bug. The sheet is the box; the form is
    // what scrolls, and it has to be free to be exactly as tall as the box.
    expect(rule(".sheet")).toMatch(/max-height:\s*88vh/);
    expect(rule(".sheet form")).not.toMatch(/max-height/);
  });

  it("lets the form shrink far enough to scroll", () => {
    // Without min-height:0 a flex item refuses to go below its content, and
    // the form pushes the sheet past 88vh instead of scrolling inside it.
    expect(rule(".sheet")).toMatch(/flex-direction:\s*column/);
    expect(rule(".sheet form")).toMatch(/min-height:\s*0/);
    expect(rule(".sheet form")).toMatch(/overflow-y:\s*auto/);
  });

  it("does not put a third scroller inside the second", () => {
    // The preview of what a specialist is told had a 150px window of its
    // own: scroll the sheet to reach it, then scroll it to read it.
    expect(rule("#s-framing")).not.toMatch(/max-height|overflow/);
  });
});
