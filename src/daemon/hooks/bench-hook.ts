import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { evaluateCommit } from "../gates/commit-attribution.js";
import { evaluateStop } from "../gates/report-required.js";

/**
 * Invoked by Claude Code as a hook command. Reads the hook payload as JSON
 * on stdin, writes a decision as JSON on stdout, exits 0.
 *
 * Output contracts verified against claude 2.1.238:
 *   PreToolUse -> { hookSpecificOutput: { hookEventName, permissionDecision, permissionDecisionReason } }
 *   Stop       -> { decision: "block", reason }   (Stop's hookSpecificOutput
 *                  only carries additionalContext, which does NOT block)
 *
 * Emitting nothing means "no opinion" and the tool call proceeds.
 */
async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

async function main(): Promise<void> {
  const gate = process.argv[2];
  const raw = await readStdin();

  let payload: Record<string, any> = {};
  try {
    payload = JSON.parse(raw);
  } catch {
    // An unreadable payload must never wedge the agent. Stay silent.
    return;
  }

  if (gate === "commit-attribution") {
    const command = String(payload.tool_input?.command ?? "");
    const { deny, reason } = evaluateCommit(command);
    if (!deny) return;

    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: reason,
        },
      }),
    );
    return;
  }

  if (gate === "report-required") {
    const reportsDir = process.env.BENCH_REPORTS_DIR;
    if (!reportsDir) return;

    // The turn marker is written by the daemon before each turn; env cannot
    // carry it because env is fixed when the process spawns.
    let turn = 0;
    try {
      turn = Number(await readFile(join(reportsDir, ".turn"), "utf8"));
    } catch {
      return;
    }
    if (!Number.isInteger(turn) || turn < 1) return;

    const { block, reason } = await evaluateStop({ reportsDir, turn });
    if (!block) return;

    process.stdout.write(JSON.stringify({ decision: "block", reason }));
  }
}

main().catch(() => {
  // A crashing gate must fail open, never leave a session stuck.
  process.exit(0);
});
