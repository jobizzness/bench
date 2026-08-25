import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { DEFAULT_THEME, isThemeId, THEMES, themeLabel } from "../src/shared/themes.js";

/**
 * A theme is a row in themes.ts and a block in styles.css, and the two have to
 * agree or the cockpit draws itself in a palette that is half one theme and
 * half whatever the default left behind. Nothing in the type system can say
 * that - one side is TypeScript and the other is a stylesheet - so it is said
 * here instead.
 */
const css = readFileSync(new URL("../src/client/styles.css", import.meta.url), "utf8");

/** The declarations inside the first block whose selector list contains one. */
function block(selector: string): string {
  const at = css.indexOf(selector);
  if (at === -1) return "";
  const open = css.indexOf("{", at);
  return css.slice(open + 1, css.indexOf("}", open));
}

function tokens(selector: string): string[] {
  return [...block(selector).matchAll(/^\s*(--[a-z-]+|color-scheme)\s*:/gm)]
    .map((match) => match[1])
    .sort();
}

/** Bench is the theme the cockpit was designed in, so it defines the list. */
const CONTRACT = tokens('[data-theme="bench"]');

describe("the token contract", () => {
  it("is not empty, or every test below passes by saying nothing", () => {
    expect(CONTRACT.length).toBeGreaterThan(15);
    expect(CONTRACT).toContain("--bg");
    expect(CONTRACT).toContain("--wants");
    expect(CONTRACT).toContain("color-scheme");
  });

  it("is applied to the root, so a page with no attribute still has a palette", () => {
    // The default is not a copy of Bench, it *is* Bench: one block, two
    // selectors. A copy is a second place to forget.
    expect(css).toContain(':root, [data-theme="bench"]');
  });

  it("leaves nothing but colour to the themes", () => {
    // Type, spacing and easing live in :root and are the same everywhere. A
    // theme that could move them would be a redesign wearing a palette's name.
    const shared = tokens(":root {");
    expect(shared).toEqual(["--ease", "--mono", "--sans", "--step"]);
  });
});

describe("every theme", () => {
  it.each(THEMES)("$label has a block in the stylesheet", (theme) => {
    expect(block(`[data-theme="${theme.id}"]`)).not.toBe("");
  });

  it.each(THEMES)("$label fills in every token, and invents none", (theme) => {
    // A missing token is the worst kind of bug here, because it does not fail:
    // it inherits Bench's deep green and shows up as one wrong-coloured corner
    // in a light theme, on a screen nobody opened that week.
    expect(tokens(`[data-theme="${theme.id}"]`)).toEqual(CONTRACT);
  });

  it.each(THEMES)("$label keeps its three status hues apart", (theme) => {
    const declared = (name: string) =>
      block(`[data-theme="${theme.id}"]`).match(new RegExp(`${name}:\\s*([^;]+);`))![1].trim();

    // Green-ish wants you, amber is in flight, red is broken. A theme may move
    // all three; it may not collapse two, because a 2px rail down the side of
    // a row is the whole of what tells them apart.
    const hues = [declared("--wants"), declared("--busy"), declared("--broken")];
    expect(new Set(hues).size).toBe(3);
  });

  it("is named once — no two share an id", () => {
    expect(new Set(THEMES.map((t) => t.id)).size).toBe(THEMES.length);
  });
});

describe("naming a theme", () => {
  it("recognises the ones that exist", () => {
    expect(isThemeId(DEFAULT_THEME)).toBe(true);
    expect(isThemeId("paper")).toBe(true);
  });

  it("refuses anything else, including the shapes storage can hand back", () => {
    expect(isThemeId("solarized")).toBe(false);
    expect(isThemeId("")).toBe(false);
    expect(isThemeId(null)).toBe(false);
    expect(isThemeId({ id: "bench" })).toBe(false);
  });

  it("shows an unknown id as itself rather than pretending", () => {
    expect(themeLabel("paper")).toBe("Paper");
    expect(themeLabel("solarized")).toBe("solarized");
  });
});
