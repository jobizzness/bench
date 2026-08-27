import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { ClaudeSession } from "../src/daemon/claude-session.js";
import { ROLES, ROLE_BRIEF, ROLE_NOTE, DEFAULT_ROLE } from "../src/shared/roles.js";

/**
 * An agent knowing what it is.
 *
 * The role used to reach the model picker and the roster row and stop there.
 * A reviewer and an implementer were handed identical text and behaved
 * identically, so choosing a role bought a cheaper model and a word on a row -
 * and `ROLE_NOTE` promised the developer a reviewer that "reads work someone
 * else did and says what is wrong with it" while the reviewer itself was never
 * told any of that.
 */

/** A fake CLI that says back the system prompt it was started with. */
const ROLE_CLI = `#!/usr/bin/env node
process.stdout.write(JSON.stringify({ type: "system", subtype: "init" }) + "\\n");
let carry = "";
process.stdin.on("data", (chunk) => {
  carry += chunk.toString();
  const lines = carry.split("\\n");
  carry = lines.pop();
  for (const line of lines) {
    if (line.trim() === "") continue;
    const argv = process.argv.slice(2);
    const at = argv.indexOf("--append-system-prompt");
    process.stdout.write(JSON.stringify({
      type: "result", subtype: "success", is_error: false,
      session_id: "fake",
      result: at === -1 ? "none" : argv[at + 1],
    }) + "\\n");
  }
});
`;

async function toldItIs(over: Record<string, unknown>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "bench-rolecli-"));
  const claudeBin = join(dir, "fake-claude.mjs");
  await writeFile(claudeBin, ROLE_CLI);
  await chmod(claudeBin, 0o755);

  const worktree = await mkdtemp(join(tmpdir(), "bench-wt-"));
  const reportsDir = join(worktree, ".bench", "reports", "sess-1");
  await mkdir(reportsDir, { recursive: true });

  const session = new ClaudeSession({
    id: "sess-1",
    label: "tester",
    worktree,
    reportsDir,
    hookCommand: "node /nonexistent/hook.js",
    pluginDir: join(process.cwd(), "plugin"),
    model: "opus",
    port: 3100,
    claudeBin,
    ...over,
  });

  const replied = once(session, "reply");
  session.open();
  session.send("go");
  const reply = (await replied)[0] as string;
  session.stop();
  return reply;
}

describe("what the agent is told it is", () => {
  it("hands a reviewer the reviewer's brief", async () => {
    expect(await toldItIs({ role: "reviewer" })).toBe(ROLE_BRIEF.reviewer);
  });

  it("gives each role a different brief", async () => {
    // The point of the change. Two roles with the same instruction is two
    // roles that behave the same way, which is what this replaced.
    const briefs = ROLES.map((role) => ROLE_BRIEF[role]);
    expect(new Set(briefs).size).toBe(ROLES.length);
  });

  it("falls back to the specialist's brief when no role was recorded", async () => {
    // Every record written before roles existed has no role, and so does an
    // older client. Those are specialists, which is what they have been all
    // along.
    expect(await toldItIs({})).toBe(ROLE_BRIEF[DEFAULT_ROLE]);
  });

  it("says it once at spawn rather than on every turn", async () => {
    // The system prompt is the right channel for a standing fact: fixed for
    // the life of the process, which is exactly what a role is, and it does
    // not cost tokens again on turn forty. House rules go in the per-turn
    // framing instead, because those are read fresh each turn.
    const session = await makeQuiet("planner");
    expect(session.args).toContain("--append-system-prompt");
    expect(session.args[session.args.indexOf("--append-system-prompt") + 1])
      .toBe(ROLE_BRIEF.planner);
  });
});

describe("the briefs themselves", () => {
  it("addresses the agent rather than describing it to a shopper", async () => {
    // ROLE_NOTE is a shopping label - third person, and half of it is about
    // Bench's own history. This is the instruction the agent runs under.
    for (const role of ROLES) {
      expect(ROLE_BRIEF[role]).toMatch(/^You are an? /);
      expect(ROLE_BRIEF[role]).not.toBe(ROLE_NOTE[role]);
    }
  });

  it("names the boundary for every role that has one", async () => {
    // The failure worth preventing is not an agent that forgets its role, it
    // is one that quietly widens it: a reviewer that starts fixing what it
    // found, a researcher that refactors the file it was sent to read.
    expect(ROLE_BRIEF.reviewer).toMatch(/you do not change it/i);
    expect(ROLE_BRIEF.planner).toMatch(/do not implement/i);
    expect(ROLE_BRIEF.researcher).toMatch(/change nothing/i);
  });

  it("tells the read-only roles what to do when told to fix it anyway", async () => {
    // The instruction in front of an agent beats the one it was started
    // with, so a brief that only says "do not fix it" loses to "deal with
    // it". These name the collision and say which way it goes.
    expect(ROLE_BRIEF.reviewer).toMatch(/even when you are told to fix it/i);
    expect(ROLE_BRIEF.researcher).toMatch(/even when you are told to change something/i);
  });

  it("leaves the specialist's brief granting everything", async () => {
    // It is the default and it is what every existing tab on every bench
    // already is, so it has to describe what they have been doing rather
    // than narrow it.
    expect(ROLE_BRIEF.specialist).not.toMatch(/do not|never/i);
  });
});

/** Build a session without running a turn, to read the argv it would spawn. */
async function makeQuiet(role: string): Promise<{ args: string[] }> {
  const seen: string[] = [];
  const worktree = await mkdtemp(join(tmpdir(), "bench-wt-"));
  const reportsDir = join(worktree, ".bench", "reports", "sess-2");
  await mkdir(reportsDir, { recursive: true });

  // `true` exits immediately; all this turn wants is the argument list.
  const session = new ClaudeSession({
    id: "sess-2",
    label: "tester",
    worktree,
    reportsDir,
    hookCommand: "node /nonexistent/hook.js",
    pluginDir: join(process.cwd(), "plugin"),
    model: "opus",
    role: role as never,
    port: 3100,
    claudeBin: "/bin/true",
  });
  const spawned = once(session, "exit");
  session.open();
  // The args are what the process was given, read back off the child.
  seen.push(...((session as unknown as { child: { spawnargs: string[] } }).child?.spawnargs ?? []));
  await spawned;
  return { args: seen };
}
