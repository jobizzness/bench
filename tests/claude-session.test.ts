import { describe, it, expect } from "vitest";
import { mkdtemp, writeFile, chmod, mkdir, readFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { ClaudeSession } from "../src/daemon/claude-session.js";

/** A stand-in for the claude CLI that speaks stream-json over stdio. */
const FAKE_CLI = `#!/usr/bin/env node
process.stdout.write(JSON.stringify({ type: "system", subtype: "init" }) + "\\n");
let carry = "";
process.stdin.on("data", (chunk) => {
  carry += chunk.toString();
  const lines = carry.split("\\n");
  carry = lines.pop();
  for (const line of lines) {
    if (line.trim() === "") continue;
    const text = JSON.parse(line).message.content;
    process.stdout.write(JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "tool_use", name: "Bash" }] },
    }) + "\\n");
    process.stdout.write(JSON.stringify({
      type: "result", subtype: "success", is_error: false,
      session_id: "fake", result: "echo:" + text,
    }) + "\\n");
  }
});
`;

/**
 * A CLI that takes its time. Each result reports how many stdin lines had
 * arrived by the moment it was produced, which is how a test can see whether
 * a queued prompt reached the CLI while a turn was still running.
 */
const SLOW_CLI = `#!/usr/bin/env node
process.stdout.write(JSON.stringify({ type: "system", subtype: "init" }) + "\\n");
let received = 0;
let carry = "";
process.stdin.on("data", (chunk) => {
  carry += chunk.toString();
  const lines = carry.split("\\n");
  carry = lines.pop();
  for (const line of lines) {
    if (line.trim() === "") continue;
    received += 1;
    const text = JSON.parse(line).message.content;
    setTimeout(() => {
      process.stdout.write(JSON.stringify({
        type: "result", subtype: "success", is_error: false,
        session_id: "fake",
        result: "echo:" + text + "|received=" + received,
      }) + "\\n");
    }, 250);
  }
});
`;

/** Echoes the argv it was launched with, so a test can assert on flags. */
const ARGS_CLI = `#!/usr/bin/env node
process.stdout.write(JSON.stringify({ type: "system", subtype: "init" }) + "\\n");
let carry = "";
process.stdin.on("data", (chunk) => {
  carry += chunk.toString();
  const lines = carry.split("\\n");
  carry = lines.pop();
  for (const line of lines) {
    if (line.trim() === "") continue;
    process.stdout.write(JSON.stringify({
      type: "result", subtype: "success", is_error: false,
      session_id: "fake", result: "argv:" + process.argv.slice(2).join(" "),
    }) + "\\n");
  }
});
`;

/** Dies the way the real CLI does when asked to resume a session that is
 * not there: one line on stderr, exit 1, nothing on stdout. */
const DYING_CLI = `#!/usr/bin/env node
process.stderr.write("No conversation found with session ID: sess-1\\n");
process.exit(1);
`;

async function makeFakeCli(source: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "bench-fakecli-"));
  const path = join(dir, "fake-claude.mjs");
  await writeFile(path, source);
  await chmod(path, 0o755);
  return path;
}

async function makeSession(cli: string = FAKE_CLI, over: Record<string, unknown> = {}) {
  const claudeBin = await makeFakeCli(cli);
  const worktree = await mkdtemp(join(tmpdir(), "bench-wt-"));
  const reportsDir = join(worktree, ".bench", "reports", "sess-1");
  await mkdir(reportsDir, { recursive: true });

  return new ClaudeSession({
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
}

describe("ClaudeSession", () => {
  it("opens without starting a turn", async () => {
    // A specialist is created before anyone has said what it is for. It must
    // sit there costing nothing until it is prompted.
    const session = await makeSession();
    const opts = (session as any).opts;

    session.open();
    await new Promise((r) => setTimeout(r, 150));

    expect(session.turn).toBe(0);
    await expect(access(join(opts.reportsDir, ".turn"))).rejects.toThrow();
    session.stop();
  });

  it("emits turn-end when the result event arrives", async () => {
    const session = await makeSession();
    const ended = once(session, "turn-end");
    session.open();
    session.send("do the thing");

    const [result] = await ended;
    expect(result.type).toBe("result");
    // The message is framed with a turn header, so match on the payload.
    expect(result.result).toContain("do the thing");
    session.stop();
  });

  it("increments the turn counter across turns", async () => {
    const session = await makeSession();
    session.open();

    session.send("first");
    await once(session, "turn-end");
    expect(session.turn).toBe(1);

    session.send("second");
    await once(session, "turn-end");
    expect(session.turn).toBe(2);

    session.stop();
  });

  it("delivers a later prompt as the next user message", async () => {
    const session = await makeSession();
    session.open();
    session.send("first");
    await once(session, "turn-end");

    const ended = once(session, "turn-end");
    session.send("chose option A");
    const [result] = await ended;

    expect(result.result).toContain("chose option A");
    expect(result.result).toContain("Turn 2");
    session.stop();
  });

  it("leaves the choice of report or reply to the agent", async () => {
    const session = await makeSession();
    const ended = once(session, "turn-end");
    session.open();
    session.send("do it");
    const [result] = await ended;

    // The framing names the directory and the four cases, and says the call
    // is the agent's. It must never declare the turn's kind for it.
    expect(result.result).toMatch(/is your call/i);
    expect(result.result).toMatch(/stuck/i);
    expect(result.result).not.toMatch(/no report is required/i);
    session.stop();
  });

  it("emits activity lines for tool calls", async () => {
    const session = await makeSession();
    const seen: string[] = [];
    session.on("activity", (line: string) => seen.push(line));

    session.open();
    session.send("work");
    await once(session, "turn-end");

    expect(seen).toContain("Bash");
    session.stop();
  });

  it("emits exit when the process ends", async () => {
    const session = await makeSession();
    session.open();
    session.send("work");
    await once(session, "turn-end");

    const exited = once(session, "exit");
    session.stop();
    await exited;
  });

  it("writes a turn marker naming the current turn", async () => {
    const session = await makeSession();
    session.open();
    session.send("work");
    await once(session, "turn-end");

    const opts = (session as any).opts;
    expect(await readFile(join(opts.reportsDir, ".turn"), "utf8")).toBe("1");

    session.send("next");
    await once(session, "turn-end");
    expect(await readFile(join(opts.reportsDir, ".turn"), "utf8")).toBe("2");

    session.stop();
  });

  it("holds a mid-turn prompt until the running turn has ended", async () => {
    const session = await makeSession(SLOW_CLI);
    const results: string[] = [];
    session.on("turn-end", (ev: any) => results.push(String(ev.result)));

    session.open();
    session.send("do the work");
    // Arrives while turn 1 is still running.
    session.send("what directory are you in?");

    await once(session, "turn-end");
    // Turn 1 must have been the only thing the CLI had received.
    expect(results[0]).toContain("received=1");
    expect(results[0]).toContain("do the work");

    await once(session, "turn-end");
    expect(results).toHaveLength(2);
    expect(results[1]).toContain("what directory are you in?");
    expect(results[1]).toContain("Turn 2");

    session.stop();
  });

  it("advances the marker to the queued turn once the running turn ends", async () => {
    const session = await makeSession();
    const opts = (session as any).opts;

    // Both results can arrive in one chunk, so count from a listener
    // attached up front rather than awaiting once() twice in sequence.
    let ends = 0;
    const twoTurns = new Promise<void>((resolve) => {
      session.on("turn-end", () => { ends += 1; if (ends === 2) resolve(); });
    });

    session.open();
    session.send("do the work");
    session.send("quick question");
    await twoTurns;

    expect(await readFile(join(opts.reportsDir, ".turn"), "utf8")).toBe("2");
    session.stop();
  });

  it("starts a new session by id", async () => {
    const session = await makeSession(ARGS_CLI);
    const ended = once(session, "turn-end");
    session.open();
    session.send("hello");
    const [result] = await ended;

    expect(result.result).toContain("--session-id sess-1");
    expect(result.result).not.toContain("--resume");
    session.stop();
  });

  it("hands the exit code and the child's last words to whoever is listening", async () => {
    // Without this the daemon can only say "process exited", and the one line
    // that explains why - which the CLI does print - is thrown away.
    const session = await makeSession(DYING_CLI);
    const exited = new Promise<{ code: number | null; stderr: string }>((resolve) => {
      session.on("exit", (code, stderr) => resolve({ code, stderr }));
    });

    session.open();
    const { code, stderr } = await exited;

    expect(code).toBe(1);
    expect(stderr).toContain("No conversation found with session ID: sess-1");
  });

  it("resumes an existing session instead of starting a new one", async () => {
    // After a daemon restart the CLI transcript is still on disk, so a
    // specialist can come back knowing what it was doing.
    const session = await makeSession(ARGS_CLI, { resume: true });
    const ended = once(session, "turn-end");
    session.open();
    session.send("hello");
    const [result] = await ended;

    expect(result.result).toContain("--resume sess-1");
    expect(result.result).not.toContain("--session-id");
    session.stop();
  });

  it("refuses to send before it has been opened", async () => {
    const session = await makeSession();
    expect(() => session.send("hi")).toThrow(/not started/i);
  });

  it("emits a reply for every turn", async () => {
    const session = await makeSession();
    const seen: string[] = [];
    session.on("reply", (text: string) => seen.push(text));

    session.open();
    session.send("do it");
    await once(session, "turn-end");
    expect(seen[0]).toContain("do it");

    session.send("why?");
    await once(session, "turn-end");
    expect(seen[1]).toContain("why?");

    session.stop();
  });
});
