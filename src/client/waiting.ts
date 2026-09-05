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

/** A row's report, not just the row - answering it and then getting a new
 * report on the same specialist is a different decision, and should not
 * still read as the one already answered. A tab held on a hand-off has no
 * report, so its key is stable. Shared between `usePhoneLanding` (which
 * decides is a row still counts as waiting) and `Row.tsx` (which decides
 * whether to keep painting the "wants you" rail on one that was just
 * answered but the roster has not caught up to yet, #93) - both have to
 * agree on the same identity or a row could read as answered in one place
 * and still waiting in the other. */
export function waitingKey(row: RosterRow): string {
  return `${row.id}:${row.latestReportSeq}`;
}

/**
 * The one waiting row that gets to look alive (#93).
 *
 * Six rows blocked on the developer at once are still one fact - "you have
 * work to do" - not six separate emergencies, and animating all six turns a
 * signal into a disco. Rather than try to keep several animations in phase
 * (fragile, and still six things moving at once even if synchronised), only
 * the first row in roster order that wants attention gets the livelier
 * treatment; the rest keep the plain, static "wants" rail they always had -
 * still legible from its colour and from the group's own count, just quiet.
 *
 * First in `rows` order rather than first on screen: a project group sorts
 * or lets the developer drag its own rows, and this does not try to track
 * that - it only has to name the same one consistently from render to
 * render, and the order the daemon hands back is stable enough for that.
 */
export function primaryWaiting(rows: RosterRow[]): string | null {
  return rows.find(wantsAttention)?.id ?? null;
}
