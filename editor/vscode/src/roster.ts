import { insideWorkspace } from "./inside.js";
import type { RosterRow } from "./types.js";

/**
 * Whether a specialist actually needs the developer.
 *
 * A copy of `isWaiting` in Bench's own `src/client/waiting.ts`, for the same
 * reason `EditEvent` is copied - this is a separate package and importing
 * across would drag the cockpit's tree in for one predicate.
 *
 * The rule is not "the status says so". A specialist that answered a
 * question and wrote no report ends its turn in `awaiting_decision` too, so
 * the status alone would badge every idle tab on the bench. It is waiting
 * when the latest report is one nobody has answered.
 */
export function isWaiting(row: RosterRow): boolean {
  return row.status === "awaiting_decision"
    && row.latestReportSeq !== null
    && row.latestReportSeq !== row.answeredReportSeq;
}

/**
 * The specialists this window can say anything useful about.
 *
 * One daemon serves every project at once, so most of a roster is about
 * repos this window does not have open. A row from another machine is left
 * out too: its paths mean nothing here, and the daemon this extension is
 * talking to cannot serve its diffs.
 */
export function specialistsHere(rows: RosterRow[], folders: string[]): RosterRow[] {
  return rows.filter((row) => row.machine === undefined && insideWorkspace(row.project, folders));
}

/** What the badge shows: people waiting on you, that you could act on here. */
export function waitingCount(rows: RosterRow[], folders: string[]): number {
  return specialistsHere(rows, folders).filter(isWaiting).length;
}
