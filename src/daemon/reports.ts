import { readFile, readdir, access } from "node:fs/promises";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { decisionSchema, type Decision } from "../shared/types.js";

export interface ReportRecord {
  seq: number;
  htmlPath: string;
  decision: Decision;
  malformed: boolean;
}

/**
 * When an agent writes a bad decision.json the developer still needs to be
 * able to reply. Degrading to free text keeps a malformed report from
 * wedging the session.
 */
function fallbackDecision(): Decision {
  return {
    kind: "question",
    title: "Report has no readable decision",
    summary: "The agent did not write a valid decision.json. Reply in free text.",
    options: [],
    questions: [],
    allowFreeText: true,
  };
}

export async function findReport(reportsDir: string, seq: number): Promise<ReportRecord | null> {
  const dir = join(reportsDir, String(seq));
  const htmlPath = join(dir, "report.html");

  try {
    await access(htmlPath);
  } catch {
    // report.html is the readiness signal. Without it there is no report.
    return null;
  }

  try {
    const raw = await readFile(join(dir, "decision.json"), "utf8");
    const parsed = decisionSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) return { seq, htmlPath, decision: fallbackDecision(), malformed: true };
    return { seq, htmlPath, decision: parsed.data, malformed: false };
  } catch {
    return { seq, htmlPath, decision: fallbackDecision(), malformed: true };
  }
}

export async function latestReportSeq(reportsDir: string): Promise<number | null> {
  let entries: string[];
  try {
    entries = await readdir(reportsDir);
  } catch {
    return null;
  }

  const seqs = entries
    .map((name) => Number(name))
    .filter((n) => Number.isInteger(n) && n > 0)
    .sort((a, b) => b - a);

  for (const seq of seqs) {
    if (await findReport(reportsDir, seq)) return seq;
  }
  return null;
}

/** Which of a reports directory's entries are turn directories, by number.
 * Everything else beside them - `.turn`, `thread.jsonl` - is not one. */
function turnNumbers(entries: string[]): number[] {
  return entries
    .map((name) => Number(name))
    .filter((n) => Number.isInteger(n) && n > 0);
}

/**
 * The highest turn this session has already used, report or not.
 *
 * A revived specialist has to keep counting from where it stopped. Starting
 * at one again silently overwrote the reports of every earlier turn, and
 * pointed the roster at the stale highest-numbered directory instead of the
 * new work.
 */
export async function latestTurn(reportsDir: string): Promise<number> {
  try {
    const turns = turnNumbers(await readdir(reportsDir));
    return turns.length === 0 ? 0 : Math.max(...turns);
  } catch {
    return 0;
  }
}

/**
 * The number the turn starting now gets: past anything this session has
 * counted, and past anything already on disk.
 *
 * Disk is consulted because a counter is not enough on its own (#163). The
 * count a session starts from is `entry.turnsTaken`, which is read from disk
 * once when the roster is restored and then only moved on by a context clear
 * - so a specialist that is stopped and revived inside one daemon uptime
 * resumes from a number its own earlier turns have already gone past (#39),
 * and walks back over directories that already hold another turn's report.
 * Observed on a real session: turns numbered 84-87 written into directories
 * that already went up to 96, and a report pane showing a four-day-old
 * report as the current turn's.
 *
 * Taking the higher of the two makes the allocated number strictly greater
 * than every directory present, so the turn's own directory is empty by
 * construction - nothing to clear, and nothing of a crashed turn's to
 * destroy, which is the other way #163 offered to fix the same symptom.
 *
 * Synchronous: every caller is a turn starting now, in code that cannot
 * await without reordering the turns it is allocating for. It is one listing
 * of one small directory, beside the `mkdirSync` and `writeFileSync` that
 * already run there.
 */
export function nextTurn(reportsDir: string, counted: number): number {
  let onDisk = 0;
  try {
    const turns = turnNumbers(readdirSync(reportsDir));
    if (turns.length > 0) onDisk = Math.max(...turns);
  } catch {
    // No directory yet, so nothing has ever run here: the counter is all
    // there is to go on.
  }
  return Math.max(counted, onDisk) + 1;
}
