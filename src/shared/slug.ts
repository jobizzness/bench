/**
 * A label is what a person calls a specialist. A slug is what git can put in
 * a branch name.
 *
 * These used to be the same string, which meant the developer had to type the
 * branch name and call it a label: lowercase, hyphens, no spaces, refused if
 * you wrote "Cash pickup" like a human being. The constraint was real - it is
 * a branch and a directory - but it belonged to the machine, and it was being
 * paid for by the person.
 */

/** What a label may not do at all: be empty, or be longer than a line. */
export const LABEL_MAX = 80;

export function labelIsUsable(label: string): boolean {
  const trimmed = label.trim();
  return trimmed.length > 0 && trimmed.length <= LABEL_MAX;
}

/**
 * "Cash pickup (v2)" becomes "cash-pickup-v2".
 *
 * Everything git dislikes in a ref goes: spaces, punctuation, accents folded
 * to their letters where the platform can, runs of hyphens collapsed. A label
 * that is entirely punctuation still has to produce something, so it falls
 * back rather than making an unnameable branch.
 */
export function slugify(label: string): string {
  const folded = label
    .normalize("NFKD")
    // Combining marks, left behind by the normalise above.
    .replace(/[̀-ͯ]/g, "");

  const slug = folded
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48)
    // Slicing can leave a trailing hyphen behind.
    .replace(/-$/, "");

  return slug === "" ? "specialist" : slug;
}
