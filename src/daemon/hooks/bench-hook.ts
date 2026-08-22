import { evaluateCommit } from "../gates/commit-attribution.js";

/**
 * Invoked by Claude Code as a hook command. Reads the hook payload as JSON
 * on stdin, writes a decision as JSON on stdout, exits 0.
 *
 * Output contracts verified against claude 2.1.238:
 *   PreToolUse -> { hookSpecificOutput: { hookEventName, permissionDecision, permissionDecisionReason } }
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

}

main().catch(() => {
  // A crashing gate must fail open, never leave a session stuck.
  process.exit(0);
});
