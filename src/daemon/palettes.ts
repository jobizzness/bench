import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The cockpit's palettes, lifted out of its stylesheet.
 *
 * A report is a separate document. The daemon builds it, the cockpit drops it
 * into a sandboxed iframe, and nothing cascades across that boundary - so the
 * frame either carries the palettes itself or stays dark on every theme,
 * which is what it did.
 *
 * Carrying them by copying them into this file was the obvious way and the
 * wrong one: five palettes written twice drift, and the drift shows up as a
 * report whose ground is a slightly different green from the cockpit around
 * it. So they are read out of the stylesheet that already defines them. The
 * theme blocks are a stable, machine-readable shape - that is what the
 * contract test in tests/themes.test.ts is for - and this is the second
 * reader of it.
 *
 * Resolved relative to this file, which lands in dist/daemon at runtime and
 * is read from src/daemon under test. Both are one hop from the stylesheet.
 */
const STYLESHEET = join(dirname(fileURLToPath(import.meta.url)), "..", "client", "styles.css");

/**
 * What Bench draws with when the stylesheet cannot be read - a broken install,
 * or a build that shipped the daemon without the client. A report that opens
 * in the wrong green beats one that opens as black text on white.
 */
const FALLBACK = `:root{--bg:#0b1210;--panel:#0f1714;--raised:#14201b;--sunk:#09100e;`
  + `--line:rgba(255,255,255,0.07);--line-firm:rgba(255,255,255,0.13);`
  + `--hover:rgba(255,255,255,0.045);--text:#dfe8e2;--muted:#7e948a;--faint:#55665e;`
  + `--wants:#63d39b;--wants-dim:#1e4f39;--busy:#d8a45f;--busy-dim:#4a3a1e;`
  + `--broken:#d9705f;color-scheme:dark}`;

let cached: string | null = null;

/**
 * Every `[data-theme]` block in the stylesheet, as CSS.
 *
 * Only the palette blocks: the figure mask, the layout and everything else in
 * there belong to the cockpit and would be two thousand lines of rules for
 * elements a report does not have.
 */
export function palettes(): string {
  if (cached !== null) return cached;

  try {
    // Comments go first, and they have to: the stylesheet explains itself at
    // length between the blocks, and a selector matched across a comment
    // would carry a paragraph of English into the report's CSS.
    const css = readFileSync(STYLESHEET, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    const blocks: string[] = [];
    // A selector list that mentions data-theme, up to the first closing brace.
    // These blocks hold declarations and never a nested rule, so the first `}`
    // is the end of one - the same assumption the contract test makes of the
    // same text.
    //
    // No anchor before the selector, and that is the whole of it: anchoring on
    // the previous `}` consumed it, so back-to-back blocks could not both
    // match and every second theme went missing. `[^{}]*` cannot cross a brace
    // on its own, which is the same guarantee without eating one.
    for (const match of css.matchAll(/([^{}]*\[data-theme=[^{}]*)\{([^}]*)\}/g)) {
      blocks.push(`${tidy(match[1])}{${tidy(match[2])}}`);
    }
    cached = blocks.length > 0 ? blocks.join("") : FALLBACK;
  } catch {
    cached = FALLBACK;
  }
  return cached;
}

/** Whitespace down. This is inlined into every report the daemon serves. */
function tidy(css: string): string {
  return css.trim().replace(/\s*\n\s*/g, "").replace(/\s{2,}/g, " ");
}
