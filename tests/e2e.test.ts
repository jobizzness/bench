import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ClaudeSession } from "../src/daemon/claude-session.js";
import { latestReportSeq, findReport } from "../src/daemon/reports.js";

const exec = promisify(execFile);
const run = process.env.BENCH_E2E === "1" ? describe : describe.skip;

const CHEAP_MODEL = "claude-haiku-4-5-20251001";

run("end to end against the real claude CLI", () => {
  it("runs a turn, writes a report, and resumes on an answer", async () => {
    // Production puts the reports directory with the project, not inside the
    // worktree, so it survives the worktree being removed. That makes it
    // outside the session's workspace - the case every earlier test missed by
    // nesting reports under the worktree, and the reason real specialists
    // wrote their reports to /tmp and Bench saw none of them.
    // Deliberately NOT under /tmp. Writes there are permitted in a way they
    // are not elsewhere, so a suite that only ever uses mkdtemp(tmpdir())
    // cannot reproduce a refused write - which is exactly how a specialist
    // silently lost every report it wrote.
    const base = join(homedir(), ".bench-e2e");
    await mkdir(base, { recursive: true });
    const project = await mkdtemp(join(base, "project-"));
    const worktree = join(project, ".claude", "worktrees", "e2e");
    await mkdir(worktree, { recursive: true });
    await exec("git", ["init", "-q", "-b", "main"], { cwd: worktree });

    const reportsDir = join(project, ".bench", "reports", "e2e");
    await mkdir(join(reportsDir, "1"), { recursive: true });

    const session = new ClaudeSession({
      id: crypto.randomUUID(),
      label: "e2e",
      worktree,
      reportsDir,
      hookCommand: `node ${join(process.cwd(), "dist", "daemon", "hooks", "bench-hook.js")}`,
      pluginDir: join(process.cwd(), "plugin"),
      model: CHEAP_MODEL,
      port: 3199,
    });

    const ended = once(session, "turn-end");
    session.open();
    session.send(
      "Use the bench-report skill. Write report.html and decision.json into " +
      `${join(reportsDir, "1")}. The report should say the repo is empty. ` +
      "Offer two options with ids 'proceed' and 'stop'. Then finish.",
    );

    const [result] = await ended;
    expect(result.is_error).toBe(false);

    const seq = await latestReportSeq(reportsDir);
    expect(seq).toBe(1);

    const report = await findReport(reportsDir, 1);
    expect(report?.malformed).toBe(false);
    expect(report?.decision.options.map((o) => o.id)).toContain("proceed");

    const html = await readFile(report!.htmlPath, "utf8");
    expect(html.length).toBeGreaterThan(0);

    const resumed = once(session, "turn-end");
    session.send('[bench] decision: chose "proceed"');
    const [second] = await resumed;
    expect(second.type).toBe("result");

    session.stop();
  }, 300_000);

  it("comes back knowing what it was doing after the daemon dies", async () => {
    const base = join(homedir(), ".bench-e2e");
    await mkdir(base, { recursive: true });
    const project = await mkdtemp(join(base, "resume-"));
    const worktree = join(project, ".claude", "worktrees", "r");
    await mkdir(worktree, { recursive: true });
    await exec("git", ["init", "-q", "-b", "main"], { cwd: worktree });
    const reportsDir = join(project, ".bench", "reports", "r");
    await mkdir(reportsDir, { recursive: true });

    const id = crypto.randomUUID();
    const opts = {
      id, label: "r", worktree, reportsDir,
      hookCommand: `node ${join(process.cwd(), "dist", "daemon", "hooks", "bench-hook.js")}`,
      pluginDir: join(process.cwd(), "plugin"),
      model: CHEAP_MODEL,
      port: 3193,
    };

    const first = new ClaudeSession(opts);
    first.open();
    first.send("Remember this codeword: PLUMTREE-47. Reply with just: noted.");
    await once(first, "turn-end");
    // The daemon dies, taking the process with it.
    first.stop();
    await once(first, "exit");

    // A new process for the same specialist, resuming the transcript on disk.
    const revived = new ClaudeSession({ ...opts, resume: true });
    const replies: string[] = [];
    revived.on("reply", (text: string) => replies.push(text));
    revived.open();
    revived.send("What was the codeword I gave you? Reply with just the codeword.");
    await once(revived, "turn-end");

    expect(replies.join(" ")).toContain("PLUMTREE-47");
    revived.stop();
  }, 300_000);
});