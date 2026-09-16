/**
 * Where in an open file the line a specialist just wrote sits.
 *
 * A specialist changing three lines of a 600-line file, opened at line 1, is
 * a file the developer already knows drawn again - the change is the thing
 * worth showing. The daemon sends the line it wrote (`EditEvent.wrote`) and
 * this finds it.
 *
 * Matched as text rather than carried as a line number on purpose: by the
 * time the editor opens the file the specialist has often written again, and
 * a number taken before that edit points at the wrong line. Text that has
 * moved is still found; text that is gone is honestly not found.
 *
 * Knows nothing about VS Code, which is what lets it be tested in Bench's own
 * suite rather than by hand in a second editor.
 */
export function offsetOf(text: string, wrote: string | undefined): number | null {
  // The daemon sends the line trimmed, so this matches inside whatever
  // indentation the file has. Nothing to look for is the ordinary case - a
  // `Write` names no line, because a new file's change is the whole of it.
  const needle = (wrote ?? "").trim();
  if (needle === "") return null;

  const at = text.indexOf(needle);
  return at === -1 ? null : at;
}
