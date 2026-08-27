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

/**
 * Whether a row wants the developer at all, for the rail and the sort order.
 *
 * Broader than `isWaiting` on purpose: a tab held on a specialist's message
 * has nothing to report, so it can never satisfy `isWaiting`, but it wants
 * you exactly as much as an unanswered decision does. Kept separate rather
 * than folded into `isWaiting` itself, because the report queue reads that
 * one to decide whether there is a report to open - and there is not.
 */
export function wantsAttention(row: RosterRow): boolean {
  return isWaiting(row) || row.status === "awaiting_dispatch";
}
