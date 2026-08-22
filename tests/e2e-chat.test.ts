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

    // A chat turn may write reply.html into its own directory - that is what
    // the reply skill asks for - but it must never produce a report.
    const turn2 = await readdir(join(reportsDir, "2")).catch(() => [] as string[]);
    expect(turn2).not.toContain("report.html");
    expect(turn2).not.toContain("decision.json");
    expect(await latestReportSeq(reportsDir)).toBe(1);

    session.stop();
  }, 300_000);

  it("answers a message sent while a turn is running in its own turn", async () => {
    const worktree = await mkdtemp(join(tmpdir(), "bench-midturn-"));
    await exec("git", ["init", "-q", "-b", "main"], { cwd: worktree });

    const reportsDir = join(worktree, ".bench", "reports", "midturn");
    await mkdir(reportsDir, { recursive: true });

    const session = new ClaudeSession({
      id: crypto.randomUUID(),
      label: "midturn",
      worktree,
      reportsDir,
      hookCommand: `node ${join(process.cwd(), "dist", "daemon", "hooks", "bench-hook.js")}`,
      pluginDir: join(process.cwd(), "plugin"),
      model: CHEAP_MODEL,
      port: 3196,
    });

    const ends: any[] = [];
    session.on("turn-end", (ev: any) => ends.push(ev));
    const replies: string[] = [];
    session.on("reply", (text: string, kind: string) => {
      if (kind === "chat") replies.push(text);
    });

    session.start("Reply with the single word: ready.");
    // Arrives while turn 1 is still running. It must not be absorbed by it.
    setTimeout(() => {
      session.message("In one short sentence, what directory are you working in?");
    }, 700);

    await once(session, "turn-end");
    await once(session, "turn-end");

    // Two turns, not one turn doing both jobs.
    expect(ends).toHaveLength(2);
    expect(ends.every((e) => e.is_error === false)).toBe(true);
    expect(replies).toHaveLength(1);

    // The work turn reports; the chat turn is exempt and only replies.
    expect(await readdir(join(reportsDir, "1"))).toContain("report.html");
    expect(await readdir(join(reportsDir, "2"))).not.toContain("report.html");
    expect(await latestReportSeq(reportsDir)).toBe(1);

    session.stop();
  }, 300_000);
});
