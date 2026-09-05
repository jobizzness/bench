import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * jsdom has no layout (see sheet-scroll.test.ts's own note on this), so the
 * proof that the phone composer actually reads as one field, with a foot row
 * composed for its width, is the screenshot in the report on #95. This is
 * the tripwire: the arrangement a real viewport would render wrong without.
 */
const css = readFileSync(join(process.cwd(), "src", "client", "styles.css"), "utf8");

// Several `@media (max-width: 720px)` blocks exist in this file (the
// composer's own send-button states, the roster, the stage header, ...);
// the one this suite cares about is the large "Phone width" section that
// carries all of them, which is the *last* one in the file. The first
// occurrence would silently match nothing this test is looking for instead
// of failing loudly, so this is anchored on the section's own heading
// rather than on the query string alone.
const PHONE_SECTION = "── Phone width";
const phoneStart = css.indexOf("@media (max-width: 720px) {", css.indexOf(PHONE_SECTION));

/** The declarations of the first rule for `selector` found at or after `from`. */
function ruleAfter(selector: string, from: number): string {
  const at = css.indexOf(`${selector} {`, from);
  if (at === -1) throw new Error(`no rule for ${selector} after ${from}`);
  const open = css.indexOf("{", at);
  return css.slice(open + 1, css.indexOf("}", open));
}

describe("the phone composer is one field, not three boxes (#95)", () => {
  it("is invisible in the box tree above the phone width", () => {
    // display: contents above 720px is what keeps the attach button, the
    // hidden file input and the textarea exactly where they were - direct
    // children of .composer-row's own flex row - so nothing above the
    // breakpoint changes just by this wrapper existing.
    expect(phoneStart).toBeGreaterThan(-1);
    const base = ruleAfter(".composer-field", 0);
    expect(base).toMatch(/display:\s*contents/);
  });

  it("becomes a real bordered field only below 720px", () => {
    const phone = ruleAfter(".composer-field", phoneStart);
    expect(phone).toMatch(/display:\s*flex/);
    expect(phone).toMatch(/border:/);
  });

  it("strips the attach button's own border inside the field, so there is one box, not two", () => {
    const attach = ruleAfter(".composer-field .composer-attach-btn", phoneStart);
    expect(attach).toMatch(/border-color:\s*transparent/);
  });

  it("does not touch #composer-send's own rules - the developer's animation, not this ticket's", () => {
    // The send button keeps its own border/colour, unlike the attach button
    // and the text box above - it is deliberately left its own attached
    // action rather than folded into .composer-field. Its own state rules
    // (idle/sending/failed, the pulse animation) are untouched by this
    // change; this only checks that .composer-field's own rule never
    // targets #composer-send.
    const phone = ruleAfter(".composer-field", phoneStart);
    expect(phone).not.toMatch(/composer-send/);
  });
});

describe("the phone composer foot keeps the hint and model, drops spend and usage (#95)", () => {
  it("hides the spend/usage/credit meter below the phone width", () => {
    const usage = ruleAfter(".usage", phoneStart);
    expect(usage).toMatch(/display:\s*none/);
  });

  it("leaves the model button undropped - it is the only place left showing it below this width", () => {
    // No rule hiding #composer-model should exist inside the phone query.
    const phoneBlock = css.slice(phoneStart);
    expect(phoneBlock).not.toMatch(/#composer-model\s*\{[^}]*display:\s*none/);
  });
});
