export interface Activity {
  at: string;
  text: string;
}

/** Long enough to see the shape of what a turn is doing, short enough to
 * broadcast with every roster update. */
export const TRAIL_LENGTH = 10;

/**
 * The trail of what a specialist actually did. Repeats are collapsed with a
 * count rather than filling the window: a turn that runs the same command
 * forty times should say so in one line, not push everything else out.
 */
export function appendActivity(trail: Activity[], text: string, at: string): Activity[] {
  const last = trail[trail.length - 1];
  if (last && stripCount(last.text) === text) {
    const next = [...trail];
    next[next.length - 1] = { at, text: `${text} (×${countOf(last.text) + 1})` };
    return next;
  }
  return [...trail, { at, text }].slice(-TRAIL_LENGTH);
}

function stripCount(text: string): string {
  return text.replace(/ \(×\d+\)$/, "");
}

function countOf(text: string): number {
  const match = text.match(/ \(×(\d+)\)$/);
  return match ? Number(match[1]) : 1;
}
