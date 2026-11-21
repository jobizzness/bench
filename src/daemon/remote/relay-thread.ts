import type { ThreadEntry } from "../../shared/types.js";

/**
 * How much of a thread goes through Firestore to a hosted cockpit.
 *
 * A remote viewer needs the conversation it is reading, not the whole
 * history: a long-running specialist's thread grows past Firestore's 1 MiB
 * field limit (realpeep's designer reached 1.36 MB over 2,082 entries), and
 * from then on every write was refused and the thread sat blank on the
 * phone. The local cockpit still reads the full thread from disk.
 *
 * Both caps apply: the count keeps a phone's render cheap, the byte budget
 * keeps a handful of very large entries from breaking the limit on their
 * own. The budget leaves room for the plan beside it in the session mirror
 * and for the codec's escaping.
 */
export const RELAY_THREAD_MAX_ENTRIES = 200;
export const RELAY_THREAD_MAX_BYTES = 512 * 1024;

/** The thread route's answer, trimmed to its newest entries for the relay.
 * Anything that is not a `{ entries: [...] }` thread passes through as is. */
export function relayThreadText(text: string): string {
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return text; }
  const entries = (parsed as { entries?: unknown })?.entries;
  if (!Array.isArray(entries)) return text;

  const kept: ThreadEntry[] = [];
  let bytes = 0;
  for (let i = entries.length - 1; i >= 0 && kept.length < RELAY_THREAD_MAX_ENTRIES; i--) {
    const size = Buffer.byteLength(JSON.stringify(entries[i]));
    // The newest entry always goes, whatever its size: a thread that shows
    // nothing is the failure this exists to stop.
    if (kept.length > 0 && bytes + size > RELAY_THREAD_MAX_BYTES) break;
    kept.unshift(entries[i] as ThreadEntry);
    bytes += size;
  }

  const omitted = entries.length - kept.length;
  if (omitted === 0) return text;

  const notice: ThreadEntry = {
    // Below every real seq, so it sorts first and never collides with one.
    seq: -1,
    at: kept[0]?.at ?? new Date(0).toISOString(),
    kind: "system",
    body: `${omitted} earlier ${omitted === 1 ? "entry is" : "entries are"} on the machine, not shown here. Open this specialist in the local cockpit for the full thread.`,
  };
  return JSON.stringify({ entries: [notice, ...kept], omitted });
}
