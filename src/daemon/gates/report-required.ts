import { access } from "node:fs/promises";
import { join } from "node:path";

const REASON =
  "Blocked: you have not written a report for this turn. " +
  "A Specialist may not end a turn without one. " +
  "Invoke the bench-report skill and write report.html and decision.json " +
  "into the report directory for this turn, then finish.";

/**
 * "Reports at end of work" as a mechanism rather than a request. The turn
 * number comes from the daemon, which increments it before each turn.
 */
export async function evaluateStop(opts: {
  reportsDir: string;
  turn: number;
}): Promise<{ block: boolean; reason: string }> {
  const candidate = join(opts.reportsDir, String(opts.turn), "report.html");
  try {
    await access(candidate);
    return { block: false, reason: "" };
  } catch {
    return { block: true, reason: REASON };
  }
}
