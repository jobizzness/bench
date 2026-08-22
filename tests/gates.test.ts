import { describe, it, expect } from "vitest";
import { evaluateCommit } from "../src/daemon/gates/commit-attribution.js";
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

describe("buildSettings", () => {
  it("registers a PreToolUse Bash hook", () => {
    const settings = buildSettings({ hookCommand: "node /opt/bench/hook.js" }) as any;

    const pre = settings.hooks.PreToolUse;
    expect(pre[0].matcher).toBe("Bash");
    expect(pre[0].hooks[0].command).toContain("commit-attribution");
  });

  it("registers no Stop hook: whether a turn earns a report is the agent's call", () => {
    const settings = buildSettings({ hookCommand: "node /opt/bench/hook.js" }) as any;
    expect(settings.hooks.Stop).toBeUndefined();
  });

  it("serialises to JSON, since it is passed to --settings as a string", () => {
    const settings = buildSettings({ hookCommand: "node /opt/bench/hook.js" });
    expect(() => JSON.parse(JSON.stringify(settings))).not.toThrow();
  });
});
