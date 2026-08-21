import { describe, it, expect } from "vitest";
import { mkdtemp, writeFile, chmod, mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { ClaudeSession } from "../src/daemon/claude-session.js";

/** A stand-in for the claude CLI that speaks stream-json over stdio. */
const FAKE_CLI = `#!/usr/bin/env node
process.stdout.write(JSON.stringify({ type: "system", subtype: "init" }) + "\\n");
let turn = 0;
let carry = "";
process.stdin.on("data", (chunk) => {
  carry += chunk.toString();
  const lines = carry.split("\\n");
  carry = lines.pop();
  for (const line of lines) {
    if (line.trim() === "") continue;
    turn += 1;
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

async function makeFakeCli(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "bench-fakecli-"));
  const path = join(dir, "fake-claude.mjs");
  await writeFile(path, FAKE_CLI);
  await chmod(path, 0o755);
  return path;
}

async function makeSession() {
  const claudeBin = await makeFakeCli();
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
  });
}

describe("ClaudeSession", () => {
  it("emits turn-end when the result event arrives", async () => {
    const session = await makeSession();
    const ended = once(session, "turn-end");
    session.start("do the thing");

    const [result] = await ended;
    expect(result.type).toBe("result");
    // The message is framed with a turn header, so match on the payload.
    expect(result.result).toContain("do the thing");
    session.stop();
  });

  it("increments the turn counter across turns", async () => {
    const session = await makeSession();

    session.start("first");
    await once(session, "turn-end");
    expect(session.turn).toBe(1);

    session.answer("second");
    await once(session, "turn-end");
    expect(session.turn).toBe(2);

    session.stop();
  });

  it("delivers an answer as the next user message", async () => {
    const session = await makeSession();
    session.start("first");
    await once(session, "turn-end");

    const ended = once(session, "turn-end");
    session.answer("chose option A");
    const [result] = await ended;

    expect(result.result).toContain("chose option A");
    expect(result.result).toContain("Turn 2");
    session.stop();
  });

  it("emits activity lines for tool calls", async () => {
    const session = await makeSession();
    const seen: string[] = [];
    session.on("activity", (line: string) => seen.push(line));

    session.start("work");
    await once(session, "turn-end");

    expect(seen).toContain("Bash");
    session.stop();
  });

  it("emits exit when the process ends", async () => {
    const session = await makeSession();
    session.start("work");
    await once(session, "turn-end");

    const exited = once(session, "exit");
    session.stop();
    await exited;
  });

  it("writes a turn marker the report gate can read", async () => {
    const session = await makeSession();
    session.start("work");
    await once(session, "turn-end");

    const opts = (session as any).opts;
    const marker = await readFile(join(opts.reportsDir, ".turn"), "utf8");
    expect(marker).toBe("1");

    session.answer("next");
    await once(session, "turn-end");
    expect(await readFile(join(opts.reportsDir, ".turn"), "utf8")).toBe("2");

    session.stop();
  });

  it("marks a started task and an answer as work turns", async () => {
    const session = await makeSession();
    const opts = (session as any).opts;

    session.start("do it");
    await once(session, "turn-end");
    expect(await readFile(join(opts.reportsDir, ".turn-kind"), "utf8")).toBe("work");

    session.answer("chose a");
    await once(session, "turn-end");
    expect(await readFile(join(opts.reportsDir, ".turn-kind"), "utf8")).toBe("work");

    session.stop();
  });

  it("marks a message as a chat turn", async () => {
    const session = await makeSession();
    session.start("do it");
    await once(session, "turn-end");

    session.message("why zod?");
    await once(session, "turn-end");

    const opts = (session as any).opts;
    expect(await readFile(join(opts.reportsDir, ".turn-kind"), "utf8")).toBe("chat");
    expect(session.turnKind).toBe("chat");

    session.stop();
  });

  it("tells a chat turn it does not need a report", async () => {
    const session = await makeSession();
    session.start("do it");
    await once(session, "turn-end");

    const ended = once(session, "turn-end");
    session.message("status?");
    const [result] = await ended;

    expect(result.result).toMatch(/do not need to write a report/i);
    expect(result.result).toContain("status?");
    session.stop();
  });

  it("refuses to message before it has been started", async () => {
    const session = await makeSession();
    expect(() => session.message("hi")).toThrow(/not started/i);
  });

  it("emits a reply carrying the turn kind", async () => {
    const session = await makeSession();
    const seen: Array<{ text: string; kind: string }> = [];
    session.on("reply", (text: string, kind: string) => seen.push({ text, kind }));

    session.start("do it");
    await once(session, "turn-end");
    expect(seen[0].kind).toBe("work");

    session.message("why?");
    await once(session, "turn-end");
    expect(seen[1].kind).toBe("chat");
    expect(seen[1].text).toContain("why?");

    session.stop();
  });

  it("refuses to answer before it has been started", async () => {
    const session = await makeSession();
    expect(() => session.answer("too early")).toThrow(/not started/i);
  });
});
