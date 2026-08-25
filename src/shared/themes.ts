/**
 * The palettes the cockpit can be drawn in.
 *
 * A theme here is a set of colours and nothing else: no layout, no type
 * scale, no density. Every rule in the stylesheet already reads its colour
 * out of a variable, so a theme is the one block that fills those variables
 * in, and the rest of the cockpit never learns which one it got.
 *
 * The names are the contract. Each id is the value of `data-theme` on the
 * root element and the key of a block in styles.css, so adding a theme is two
 * edits that have to agree - a row here and a block there - and nothing else.
 *
 * What every theme has to keep is the meaning of the hues: green-ish wants
 * you, amber is in flight, red is broken. A theme may move those three around
 * the wheel, but it may not collapse two of them into the same colour, or the
 * rail down the side of a row stops being readable at a glance, which is the
 * one thing it exists for.
 */
export interface Theme {
  /** The `data-theme` value, and the key of the block in styles.css. */
  id: string;
  label: string;
  /** What it is for, in the picker. One line. */
  note: string;
}

export const THEMES: readonly Theme[] = [
  { id: "bench", label: "Bench", note: "The instrument panel. Deep green, low light." },
  { id: "slate", label: "Slate", note: "Neutral graphite, and blue for the thing that wants you." },
  { id: "ink", label: "Ink", note: "Indigo and violet. The quietest of the dark ones." },
  { id: "paper", label: "Paper", note: "Light. For a bright room, or a screen you print from." },
  { id: "contrast", label: "Contrast", note: "Black, white, and saturated status. Built to be legible first." },
];

/** What the cockpit draws itself in until someone says otherwise. */
export const DEFAULT_THEME = "bench";

export function isThemeId(value: unknown): value is string {
  return typeof value === "string" && THEMES.some((theme) => theme.id === value);
}

export function themeLabel(id: string): string {
  return THEMES.find((theme) => theme.id === id)?.label ?? id;
}
