import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AntigravitySession } from "../src/daemon/antigravity-session.js";
import { antigravityContextWindow } from "../src/daemon/antigravity-models.js";
import { contextTone, fractionUsed } from "../src/shared/context-window.js";

async function makeHarness(mode = "normal") {
  const dir = await mkdtemp(join(tmpdir(), "bench-agy-sess-test-"));
  const worktree = join(dir, "worktree");
  const reportsDir = join(dir, "reports");
  await mkdir(worktree, { recursive: true });
  await mkdir(reportsDir, { recursive: true });

  const script = `#!/usr/bin/env node
const mode = ${JSON.stringify(mode)};
let carry = "";
const send = (v) => process.stdout.write(JSON.stringify(v) + "\\n");

send({ event: "init", conversation_id: "agy-conv-777" });

process.stdin.on("data", (chunk) => {
  carry += chunk.toString();
  const lines = carry.split("\\n");
  carry = lines.pop();
  for (const line of lines) {
    if (!line.trim()) continue;
    const req = JSON.parse(line);
    if (req.event === "user") {
      if (mode === "inspect") {
        send({
          event: "result",
          conversation_id: "agy-conv-777",
          status: "SUCCESS",
          response: JSON.stringify({
            args: process.argv.slice(2),
            env: {
              BENCH_SESSION_ID: process.env.BENCH_SESSION_ID,
              BENCH_SELF_MODEL: process.env.BENCH_SELF_MODEL,
            },
            input: req,
          }),
          usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150 },
        });
      } else {
        send({
          event: "step_update",
          step_update: {
            step_type: "tool_call",
            tool_name: "run_command",
            tool_info: { command: "git diff" },
            usage: { input_tokens: 80, output_tokens: 20, total_tokens: 100 },
          },
        });
        send({
          event: "result",
          conversation_id: "agy-conv-777",
          status: "SUCCESS",
          response: "Finished turn successfully.",
          usage: { input_tokens: 120, output_tokens: 40, total_tokens: 160, cache_read_tokens: 10 },
        });
      }
    }
  }
});
`;
  const agyBin = join(dir, "fake-agy.mjs");
  await writeFile(agyBin, script);
  await chmod(agyBin, 0o755);

  return { dir, worktree, reportsDir, agyBin };
}

describe("AntigravitySession", () => {
  it("spawns agy with stream-json and expected args & env", async () => {
    const { worktree, reportsDir, agyBin } = await makeHarness("inspect");
    let sessionSid = "";

    const session = new AntigravitySession({
      id: "sess-inspect",
      worktree,
      reportsDir,
      agyBin,
      model: "gemini-3.8-flash-high",
      resumeSessionId: "prior-session-123",
      onSessionId: (sid) => { sessionSid = sid; },
      rules: () => "Be thorough.",
    });

    session.open();
    // Wait for init event
    await new Promise<void>((resolve) => {
      const interval = setInterval(() => {
        if (sessionSid) { clearInterval(interval); resolve(); }
      }, 20);
    });
    expect(sessionSid).toBe("agy-conv-777");

    let resultPayload: any = null;
    session.on("turn-end", (res) => {
      resultPayload = JSON.parse(res.result);
    });

    session.send("Inspect environment please.");

    await new Promise<void>((resolve) => {
      const interval = setInterval(() => {
        if (resultPayload) { clearInterval(interval); resolve(); }
      }, 20);
    });

    expect(resultPayload.args).toContain("--input-format");
    expect(resultPayload.args).toContain("stream-json");
    expect(resultPayload.args).toContain("--output-format");
    expect(resultPayload.args).toContain("stream-json");
    expect(resultPayload.args).toContain("--dangerously-skip-permissions");
    expect(resultPayload.args).toContain("--conversation");
    expect(resultPayload.args).toContain("prior-session-123");
    expect(resultPayload.args).toContain("--model");
    expect(resultPayload.args).toContain("gemini-3.8-flash-high");

    expect(resultPayload.env.BENCH_SESSION_ID).toBe("sess-inspect");
    expect(resultPayload.env.BENCH_SELF_MODEL).toBe("agy:gemini-3.8-flash-high");

    expect(resultPayload.input.event).toBe("user");
    expect(resultPayload.input.message.role).toBe("user");
    expect(resultPayload.input.message.content).toContain("[bench] Turn 1.");
    expect(resultPayload.input.message.content).toContain("Be thorough.");

    session.stop();
  });

  it("handles activity, reply, usage, and turn-end events", async () => {
    const { worktree, reportsDir, agyBin } = await makeHarness("normal");
    const activities: string[] = [];
    let turnReply = "";
    let turnEndEvent: any = null;

    const session = new AntigravitySession({
      id: "sess-events",
      worktree,
      reportsDir,
      agyBin,
    });

    session.on("activity", (act) => activities.push(act));
    session.on("reply", (rep) => { turnReply = rep; });
    session.on("turn-end", (end) => { turnEndEvent = end; });

    session.send("Do something");

    await new Promise<void>((resolve) => {
      const interval = setInterval(() => {
        if (turnEndEvent) { clearInterval(interval); resolve(); }
      }, 20);
    });

    expect(activities).toContain("run_command git diff");
    expect(turnReply).toBe("Finished turn successfully.");
    expect(turnEndEvent.type).toBe("result");
    expect(turnEndEvent.is_error).toBe(false);
    expect(turnEndEvent.usage.totalTokens).toBe(160);
    expect(session.turnTokens).toBe(160);
    expect(session.contextUsed?.used).toBe(130); // inTokens (120) + cacheRead (10)
    expect(session.contextUsed?.window).toBe(1_048_576);
    expect(contextTone(session.contextUsed)).toBe("ok");
    expect(fractionUsed(session.contextUsed)! < 0.10).toBe(true);

    session.stop();
  });

  it("computes context window per model family (#171)", () => {
    expect(antigravityContextWindow()).toBe(1_048_576);
    expect(antigravityContextWindow("gemini-3.8-flash-high")).toBe(1_048_576);
    expect(antigravityContextWindow("gemini-4-argon-high")).toBe(1_048_576);
    expect(antigravityContextWindow("gemini-2.5-pro")).toBe(2_097_152);
    expect(antigravityContextWindow("claude-opus-5-5-high")).toBe(1_000_000);
  });

  it("reports turnAnsweredBy prefixed with agy: (#171)", () => {
    const defaultSession = new AntigravitySession({
      id: "sess-default",
      worktree: tmpdir(),
      reportsDir: tmpdir(),
    });
    expect(defaultSession.turnAnsweredBy).toEqual(["agy"]);

    const namedSession = new AntigravitySession({
      id: "sess-named",
      worktree: tmpdir(),
      reportsDir: tmpdir(),
      model: "gemini-3.8-flash-high",
    });
    expect(namedSession.turnAnsweredBy).toEqual(["agy:gemini-3.8-flash-high"]);
  });
});
