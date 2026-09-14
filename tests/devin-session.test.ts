import { once } from "node:events";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ClaudeSession } from "../src/daemon/claude-session.js";
import { DevinSession } from "../src/daemon/devin-session.js";
import { SessionStore } from "../src/daemon/store.js";

const ACP_SERVER = `#!/usr/bin/env node
const mode = ${JSON.stringify("__MODE__")};
let carry = "";
let prompts = 0;
let initialized = false;
let setup = null;
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
process.stdin.on("data", (chunk) => {
  carry += chunk.toString();
  const lines = carry.split("\\n");
  carry = lines.pop();
  for (const line of lines) {
    if (!line.trim()) continue;
    const request = JSON.parse(line);
    if (request.method === "initialize") {
      initialized = request.params.protocolVersion === 1 && request.params.clientInfo.name === "bench";
      send({ jsonrpc: "2.0", id: request.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true }, authMethods: [] } });
    } else if (request.method === "session/new") {
      setup = request.params;
      send({ jsonrpc: "2.0", id: request.id, result: { sessionId: "devin-session" } });
    } else if (request.method === "session/load") {
      setup = request.params;
      send({ jsonrpc: "2.0", id: request.id, result: null });
    } else if (request.method === "session/prompt") {
      prompts += 1;
      const text = request.params.prompt.find((block) => block.type === "text").text;
      if (mode === "die") {
        process.stderr.write("ACP child died during prompt\\n");
        process.exit(7);
      }
      const answer = mode === "inspect"
        ? JSON.stringify({ initialized, setup, cwd: process.cwd(), text })
        : text + "|received=" + prompts;
      const finish = () => {
        send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "devin-session", update: { sessionUpdate: "tool_call", title: "Editing file", status: "in_progress" } } });
        send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "devin-session", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: answer } } } });
        send({ jsonrpc: "2.0", id: request.id, result: { stopReason: mode === "refusal" ? "refusal" : "end_turn" } });
      };
      if (mode === "slow") setTimeout(finish, 150); else finish();
    }
  }
});
`;

const CLAUDE_ECHO = `#!/usr/bin/env node
let carry = "";
process.stdin.on("data", (chunk) => {
  carry += chunk.toString();
  const lines = carry.split("\\n");
  carry = lines.pop();
  for (const line of lines) {
    if (!line.trim()) continue;
    const text = JSON.parse(line).message.content;
    process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, session_id: "claude", result: text }) + "\\n");
  }
});
`;

async function executable(source: string, name: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "bench-devin-test-"));
  const path = join(dir, name);
  await writeFile(path, source);
  await chmod(path, 0o755);
  return path;
}

async function makeSession(mode = "clean", over: Partial<ConstructorParameters<typeof DevinSession>[0]> = {}) {
  const devinBin = await executable(ACP_SERVER.replace('"__MODE__"', JSON.stringify(mode)), "fake-devin.mjs");
  const worktree = await mkdtemp(join(tmpdir(), "bench-devin-wt-"));
  return new DevinSession({
    id: "bench-session",
    worktree,
    reportsDir: join(worktree, ".bench", "reports", "bench-session"),
    devinBin,
    ...over,
  });
}

async function turn(session: DevinSession, text: string) {
  const ended = once(session, "turn-end");
  session.send(text);
  return (await ended)[0];
}

describe("DevinSession", () => {
  it("completes initialize and session/new before sending a prompt", async () => {
    const session = await makeSession("inspect");
    session.open();
    const result = await turn(session, "hello");
    const inspected = JSON.parse(result.result);

    expect(inspected.initialized).toBe(true);
    expect(inspected.setup).toEqual({ cwd: (session as any).opts.worktree, mcpServers: [] });
    expect(inspected.cwd).toBe((session as any).opts.worktree);
    expect(inspected.text).toContain("hello");
    session.stop();
  });

  it("persists Devin's session id before dispatching the first prompt", async () => {
    const home = await mkdtemp(join(tmpdir(), "bench-devin-store-"));
    const store = new SessionStore(home);
    await store.put({
      id: "bench-session", label: "devin", project: "/project", worktree: "/worktree",
      branch: "bench/devin", reportsDir: "/reports", model: "devin", port: 3100,
      createdAt: new Date().toISOString(),
    });
    const session = await makeSession("clean", {
      onSessionId: (sessionId) => store.rememberRuntimeSessionId("bench-session", sessionId),
    });
    session.open();
    await turn(session, "work");

    expect((await store.all())[0].runtimeSessionId).toBe("devin-session");
    await store.forgetConversation("bench-session");
    expect((await store.all())[0].runtimeSessionId).toBeUndefined();
    session.stop();
  });

  it("loads the persisted Devin session id rather than the Bench id", async () => {
    const session = await makeSession("inspect", { resumeSessionId: "devin-persisted" });
    session.open();
    const result = await turn(session, "continue");
    const inspected = JSON.parse(result.result);

    expect(inspected.setup).toEqual({
      sessionId: "devin-persisted",
      cwd: (session as any).opts.worktree,
      mcpServers: [],
    });
    expect(result.session_id).toBe("devin-persisted");
    session.stop();
  });

  it("emits one reply before one clean turn-end with no invented usage", async () => {
    const session = await makeSession();
    const order: string[] = [];
    session.on("reply", () => order.push("reply"));
    session.on("turn-end", () => order.push("turn-end"));
    session.open();
    const result = await turn(session, "work");

    expect(order).toEqual(["reply", "turn-end"]);
    expect(result).toMatchObject({ type: "result", subtype: "end_turn", is_error: false, session_id: "devin-session" });
    expect(result).not.toHaveProperty("total_cost_usd");
    expect(session.contextUsed).toBeNull();
    expect(session.turnTokens).toBe(0);
    expect(session.turnGenerationIds).toEqual([]);
    expect(session.turnAnsweredBy).toEqual([]);
    session.stop();
  });

  it("surfaces tool calls as activity", async () => {
    const session = await makeSession();
    const activity: string[] = [];
    session.on("activity", (line) => activity.push(line));
    session.open();
    await turn(session, "work");
    expect(activity).toEqual(["Editing file — in_progress"]);
    session.stop();
  });

  it("folds a burst during one turn into one following turn", async () => {
    const session = await makeSession("slow");
    const results: string[] = [];
    session.on("turn-end", (result) => results.push(result.result ?? ""));
    session.open();
    session.send("first");
    session.send("second");
    session.send("third");
    await new Promise<void>((resolve) => session.on("turn-end", () => { if (results.length === 2) resolve(); }));

    expect(results).toHaveLength(2);
    expect(results[1]).toContain("Answer them together, as one turn, not one at a time:");
    expect(results[1]).toContain("1. second");
    expect(results[1]).toContain("2. third");
    expect(results[1]).toContain("|received=2");
    session.stop();
  });

  it("marks a non-clean stop reason as an error", async () => {
    const session = await makeSession("refusal");
    session.open();
    const result = await turn(session, "work");
    expect(result).toMatchObject({ subtype: "refusal", is_error: true });
    session.stop();
  });

  it("emits exit with stderr when the child dies mid-turn", async () => {
    const session = await makeSession("die");
    const exited = once(session, "exit");
    session.open();
    session.send("work");
    const [code, stderr] = await exited;
    expect(code).toBe(7);
    expect(stderr).toContain("ACP child died during prompt");
  });

  it("uses byte-identical turn framing to ClaudeSession", async () => {
    const worktree = await mkdtemp(join(tmpdir(), "bench-frame-wt-"));
    const reportsDir = join(worktree, ".bench", "reports", "same-session");
    const rules = () => "[bench] House rules.";
    const claudeBin = await executable(CLAUDE_ECHO, "fake-claude.mjs");
    const claude = new ClaudeSession({
      id: "same-session", label: "same", worktree, reportsDir,
      hookCommand: "none", pluginDir: worktree, model: "opus", port: 3100,
      claudeBin, rules,
    });
    const devin = await makeSession("clean", { worktree, reportsDir, rules });
    claude.open();
    devin.open();
    const claudeEnded = once(claude, "turn-end");
    const devinEnded = once(devin, "turn-end");
    claude.send("same prompt");
    devin.send("same prompt");
    const claudeText = String((await claudeEnded)[0].result);
    const devinText = String((await devinEnded)[0].result).split("|received=")[0];
    const frameStart = "[bench] Turn 1.";

    expect(devinText.slice(devinText.indexOf(frameStart))).toBe(claudeText);
    claude.stop();
    devin.stop();
  });
});
