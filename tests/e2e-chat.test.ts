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

async function makeSession(tag: string, port: number) {
  const worktree = await mkdtemp(join(tmpdir(), `bench-${tag}-`));
  await exec("git", ["init", "-q", "-b", "main"], { cwd: worktree });

  const reportsDir = join(worktree, ".bench", "reports", tag);
  await mkdir(reportsDir, { recursive: true });

  const session = new ClaudeSession({
    id: crypto.randomUUID(),
    label: tag,
    worktree,
    reportsDir,
    hookCommand: `node ${join(process.cwd(), "dist", "daemon", "hooks", "bench-hook.js")}`,
    pluginDir: join(process.cwd(), "plugin"),
    model: CHEAP_MODEL,
    port,
  });
  return { session, reportsDir };
}

run("turns against the real claude CLI", () => {
  it("leaves a trivial prompt unreported", async () => {
    // Nothing forces a report any more. A question with a one-line answer
    // must not manufacture one.
    const { session, reportsDir } = await makeSession("trivial", 3197);

    const replies: string[] = [];
    session.on("reply", (text: string) => replies.push(text));

    session.open();
    session.send("In one short sentence, what directory are you working in?");
    await once(session, "turn-end");

    expect(replies).toHaveLength(1);
    expect(replies[0].length).toBeGreaterThan(0);
    expect(await latestReportSeq(reportsDir)).toBeNull();

    session.stop();
  }, 300_000);

  it("answers a prompt sent while a turn is running in its own turn", async () => {
    const { session, reportsDir } = await makeSession("midturn", 3196);

    const ends: any[] = [];
    session.on("turn-end", (ev: any) => ends.push(ev));
    const replies: string[] = [];
    session.on("reply", (text: string) => replies.push(text));

    session.open();
    session.send("Reply with the single word: ready.");
    // Arrives while turn 1 is still running. It must not be absorbed by it.
    setTimeout(() => {
      session.send("In one short sentence, what directory are you working in?");
    }, 700);

    await once(session, "turn-end");
    await once(session, "turn-end");

    // Two turns, not one turn doing both jobs.
    expect(ends).toHaveLength(2);
    expect(ends.every((e) => e.is_error === false)).toBe(true);
    expect(replies).toHaveLength(2);

    // Turn 2 was prompted after turn 1 ended, so it saw its own turn header.
    const dirs = await readdir(reportsDir);
    expect(dirs).not.toContain("3");

    session.stop();
  }, 300_000);
});
