import { appendFile, readFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { ThreadEntry, ThreadEntryInput } from "../shared/types.js";

/**
 * One JSON object per line. Sequence numbers are assigned at read time from
 * line order, so an append never has to read the file first and two appends
 * can never collide on a number.
 */
export async function appendEntry(threadPath: string, input: ThreadEntryInput): Promise<void> {
  await mkdir(dirname(threadPath), { recursive: true });
  const record = { at: new Date().toISOString(), ...input };
  await appendFile(threadPath, JSON.stringify(record) + "\n", "utf8");
}

export async function readThread(threadPath: string): Promise<ThreadEntry[]> {
  let raw: string;
  try {
    raw = await readFile(threadPath, "utf8");
  } catch {
    // No thread yet, or unreadable. An empty thread is a valid answer.
    return [];
  }

  const entries: ThreadEntry[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    try {
      const parsed = JSON.parse(trimmed) as Omit<ThreadEntry, "seq">;
      entries.push({ ...parsed, seq: entries.length + 1 });
    } catch {
      // A corrupt line loses one entry, never the whole conversation.
    }
  }
  return entries;
}
