import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { readThread, summariseThread } from "./thread.js";

export interface ClearContextReport {
  /** The turn slot this report was written into, so the caller can reserve
   * it and keep the next real turn from writing over it. */
  seq: number;
  /** The same text the fresh session's first prompt is primed with - kept
   * here too so a daemon restart before that prompt is sent can still find
   * it on disk rather than losing it with the process. */
  summary: string;
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * The developer-facing half of a cleared context. `summariseThread` writes
 * for the specialist that is about to read it as a prompt; this renders the
 * same material for the person who cleared it - the actual lines said,
 * without the instructions bracketing them.
 */
function renderReportHtml(summary: string, clearCount: number): string {
  const items = summary
    .split("\n")
    .filter((line) => line.startsWith("- "))
    .map((line) => `<li>${escapeHtml(line.slice(2))}</li>`)
    .join("\n");

  const body = items === ""
    ? "<p>Nothing to summarize yet - this specialist had no prior conversation.</p>"
    : `<ul>${items}</ul>`;

  return (
    `<p data-bench="verdict"><strong>Context cleared (version ${clearCount}).</strong> `
    + `The next message continues from what is summarized below.</p>\n${body}`
  );
}

/**
 * Writes the same report.html/decision.json shape a specialist writes for
 * itself, so a cleared conversation leaves a durable, roster-visible record
 * instead of a summary held only in memory - which a daemon restart between
 * the clear and the next prompt would otherwise lose outright.
 */
export async function writeClearContextReport(
  reportsDir: string,
  threadPath: string,
  seq: number,
  clearCount: number,
): Promise<ClearContextReport> {
  const entries = await readThread(threadPath);
  const summary = summariseThread(entries);

  const dir = join(reportsDir, String(seq));
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "report.html"), renderReportHtml(summary, clearCount));
  await writeFile(
    join(dir, "decision.json"),
    JSON.stringify(
      {
        kind: "completion",
        title: "Context cleared",
        summary: summary === ""
          ? "Nothing to summarize yet - the next message starts clean."
          : "The conversation so far is summarized - the next message continues from it.",
      },
      null,
      2,
    ) + "\n",
  );

  return { seq, summary };
}
