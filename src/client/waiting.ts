import type { RosterRow } from "../shared/types.js";

/**
 * Whether a specialist actually needs the developer.
 *
 * `awaiting_decision` only means the turn ended - a specialist that answered
 * a question and wrote no report has that status too. It is waiting on you
 * when the latest report is one you have not answered yet.
 */
export function isWaiting(row: RosterRow): boolean {
  return row.status === "awaiting_decision"
    && row.latestReportSeq !== null
    && row.latestReportSeq !== row.answeredReportSeq;
}
