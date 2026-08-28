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

/**
 * Builds a clean chronological summary of the conversation thread.
 * This is used during context clearance to provide the resurrected Claude
 * session with high-level background on what was already built and decided,
 * preventing a complete loss of situational context.
 */
export function summariseThread(entries: ThreadEntry[]): string {
  if (entries.length === 0) return "";

  const lines: string[] = [];
  lines.push("[bench] BELOW IS A CHRONOLOGICAL SUMMARY OF THE CONVERSATION HISTORY BEFORE YOUR CONTEXT WAS CLEARED.");
  lines.push("Use this summary to understand what has already been built, what files were touched, and what decisions the developer made, so you can continue the work smoothly without repeating previous questions or analysis:");

  for (const entry of entries) {
    if (entry.kind === "system" && (entry.body.startsWith("Context cleared") || entry.body.startsWith("Context version"))) {
      continue;
    }

    const maxLen = 300;
    let body = entry.body.trim();
    if (body.length > maxLen) {
      body = body.slice(0, maxLen) + "... [truncated]";
    }

    if (entry.kind === "user") {
      lines.push(`- Developer: ${body}`);
    } else if (entry.kind === "reply") {
      lines.push(`- Specialist: ${body}`);
    } else if (entry.kind === "report") {
      lines.push(`- Report ("${entry.body}"): see reports directory for details.`);
    }
  }

  return lines.join("\n");
}

