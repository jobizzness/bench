import { readFile, readdir, access } from "node:fs/promises";
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
