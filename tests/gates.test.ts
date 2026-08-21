import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evaluateCommit } from "../src/daemon/gates/commit-attribution.js";
import { evaluateStop } from "../src/daemon/gates/report-required.js";
import { buildSettings } from "../src/daemon/gates/settings.js";

describe("evaluateCommit", () => {
  it("denies a Co-Authored-By trailer", () => {
    const r = evaluateCommit('git commit -m "fix thing\n\nCo-Authored-By: Claude <noreply@anthropic.com>"');
    expect(r.deny).toBe(true);
  });

  it("denies a Generated with Claude Code footer", () => {
    const r = evaluateCommit('git commit -m "feat: x\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)"');
    expect(r.deny).toBe(true);
  });

  it("denies an Anthropic co-author trailer", () => {
    expect(evaluateCommit('git commit -m "x\n\nCo-authored-by: Anthropic"').deny).toBe(true);
  });

  it("allows an ordinary commit", () => {
    expect(evaluateCommit('git commit -m "fix: correct the port allocation"').deny).toBe(false);
  });

  it("allows a commit that merely mentions claude as subject matter", () => {
    // The rule bans attribution, not the word. This must not become a
    // keyword filter that blocks legitimate work on Claude-related files.
    expect(evaluateCommit('git commit -m "docs: document the CLAUDE.md precedence rule"').deny).toBe(false);
  });

  it("ignores commands that are not git commit", () => {
    expect(evaluateCommit('echo "Co-Authored-By: Claude"').deny).toBe(false);
  });

  it("gives a reason explaining what to do instead", () => {
    const r = evaluateCommit('git commit -m "x\n\nCo-Authored-By: Claude <noreply@anthropic.com>"');
    expect(r.reason).toMatch(/attribution/i);
  });
});

describe("evaluateStop", () => {
  const makeReports = async () => mkdtemp(join(tmpdir(), "bench-reports-"));

  it("blocks when the turn produced no report", async () => {
    const reportsDir = await makeReports();
    const r = await evaluateStop({ reportsDir, turn: 1 });
    expect(r.block).toBe(true);
    expect(r.reason).toMatch(/report/i);
  });

  it("allows when the turn produced a report", async () => {
    const reportsDir = await makeReports();
    await mkdir(join(reportsDir, "1"), { recursive: true });
    await writeFile(join(reportsDir, "1", "report.html"), "<h1>done</h1>");

    const r = await evaluateStop({ reportsDir, turn: 1 });
    expect(r.block).toBe(false);
  });

  it("blocks when only an older turn's report exists", async () => {
    const reportsDir = await makeReports();
    await mkdir(join(reportsDir, "1"), { recursive: true });
    await writeFile(join(reportsDir, "1", "report.html"), "<h1>old</h1>");

    const r = await evaluateStop({ reportsDir, turn: 2 });
    expect(r.block).toBe(true);
  });

  it("blocks when the directory exists but report.html does not", async () => {
    const reportsDir = await makeReports();
    await mkdir(join(reportsDir, "1"), { recursive: true });

    const r = await evaluateStop({ reportsDir, turn: 1 });
    expect(r.block).toBe(true);
  });
});

describe("buildSettings", () => {
  it("registers a PreToolUse Bash hook and a Stop hook", () => {
    const settings = buildSettings({ hookCommand: "node /opt/bench/hook.js" }) as any;

    const pre = settings.hooks.PreToolUse;
    expect(pre[0].matcher).toBe("Bash");
    expect(pre[0].hooks[0].command).toContain("commit-attribution");

    const stop = settings.hooks.Stop;
    expect(stop[0].hooks[0].command).toContain("report-required");
  });

  it("serialises to JSON, since it is passed to --settings as a string", () => {
    const settings = buildSettings({ hookCommand: "node /opt/bench/hook.js" });
    expect(() => JSON.parse(JSON.stringify(settings))).not.toThrow();
  });
});
