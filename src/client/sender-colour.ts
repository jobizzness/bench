import type { MessageSender } from "../shared/types.js";

/**
 * One colour per sender, so a thread with five tabs talking in it can be
 * read at a glance. A specialist's colour comes from its label, so it is the
 * same in every thread it shows up in, on every device. Eight hues, spaced
 * so neighbours never look alike, at a lightness that reads on the dark
 * ground and the light one.
 */
const HUES = [205, 30, 280, 50, 170, 340, 95, 240];

export function senderColour(sender: MessageSender): string {
  if (sender.kind === "developer") return "var(--text)";
  if (sender.kind === "bench") return "var(--faint)";
  return labelColour(sender.label);
}

export function labelColour(label: string): string {
  let hash = 0;
  for (const ch of label) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return `hsl(${HUES[hash % HUES.length]} 62% 64%)`;
}
