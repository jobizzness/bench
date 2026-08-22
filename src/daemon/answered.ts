import type { ThreadEntry } from "../shared/types.js";

/**
 * The report the developer has already answered.
 *
 * A decision is answered by prompting the specialist - that is the whole
 * interaction - and the thread records both sides in order. So a report is
 * answered exactly when a message from the developer follows it, and nothing
 * new has to be written down to know it.
 *
 * Without this the roster cannot tell "report 3 needs an answer" from
 * "report 3 was answered and the specialist has since replied", because both
 * are a session waiting on you with report 3 as the latest.
 */
export function answeredReportSeq(entries: ThreadEntry[]): number | null {
  let lastReport: number | null = null;
  let answered: number | null = null;

  for (const entry of entries) {
    if (entry.kind === "report" && typeof entry.reportSeq === "number") {
      lastReport = entry.reportSeq;
    } else if (entry.kind === "user" && lastReport !== null) {
      answered = lastReport;
    }
  }
  return answered;
}
