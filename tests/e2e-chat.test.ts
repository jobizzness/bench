import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ClaudeSession } from "../src/daemon/claude-session.js";
import { latestReportSeq } from "../src/daemon/reports.js";

const exec = promisify(execFile);
const run = process.env.BENCH_E2E === "1" ? describe : describe.skip;

const CHEAP_MODEL = "claude-haiku-4-5-20251001";

run("chat turns against the real claude CLI", () => {
  it("answers a question in prose without writing a report", async () => {
    const worktree = await mkdtemp(join(tmpdir(), "bench-chat-"));
    await exec("git", ["init", "-q", "-b", "main"], { cwd: worktree });

    const reportsDir = join(worktree, ".bench", "reports", "chat");
    await mkdir(reportsDir, { recursive: true });

    const session = new ClaudeSession({
      id: crypto.randomUUID(),
      label: "chat",
      worktree,
      reportsDir,
      hookCommand: `node ${join(process.cwd(), "dist", "daemon", "hooks", "bench-hook.js")}`,
      pluginDir: join(process.cwd(), "plugin"),
      model: CHEAP_MODEL,
      port: 3197,
    });

    // A work turn: the gate forces a report even though none was asked for.
    session.start("Reply with the single word: ready.");
    await once(session, "turn-end");
    expect(await latestReportSeq(reportsDir)).toBe(1);

    // A chat turn: no report may be required of it.
    const replies: string[] = [];
    session.on("reply", (text: string, kind: string) => {
      if (kind === "chat") replies.push(text);
    });

    session.message("In one short sentence, what directory are you working in?");
    await once(session, "turn-end");

    expect(replies).toHaveLength(1);
    expect(replies[0].length).toBeGreaterThan(0);

    // Turn 2 must not have produced a report directory.
    const dirs = await readdir(reportsDir);
    expect(dirs).not.toContain("2");
    expect(await latestReportSeq(reportsDir)).toBe(1);

    session.stop();
  }, 300_000);
});
