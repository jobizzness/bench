import { access } from "node:fs/promises";
import { join } from "node:path";
import type { TurnKind } from "../../shared/types.js";

const REASON =
  "Blocked: you have not written a report for this turn. " +
  "A Specialist may not end a work turn without one. " +
  "Invoke the bench-report skill and write report.html and decision.json " +
  "into the report directory for this turn, then finish.";

/**
 * "Reports at end of work" as a mechanism rather than a request. A chat
 * turn is exempt: the developer asked a question, and answering it in
 * prose is the whole job.
 */
export async function evaluateStop(opts: {
  reportsDir: string;
  turn: number;
  kind: TurnKind;
}): Promise<{ block: boolean; reason: string }> {
  if (opts.kind === "chat") return { block: false, reason: "" };

  const candidate = join(opts.reportsDir, String(opts.turn), "report.html");
  try {
    await access(candidate);
    return { block: false, reason: "" };
  } catch {
    return { block: true, reason: REASON };
  }
}
