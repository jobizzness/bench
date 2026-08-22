import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
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
    const worktree = await mkdtemp(join(tmpdir(), "bench-e2e-"));
    await exec("git", ["init", "-q", "-b", "main"], { cwd: worktree });

    const reportsDir = join(worktree, ".bench", "reports", "e2e");
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
});
