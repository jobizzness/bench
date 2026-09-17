import { once } from "node:events";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
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
let promptRequestId = null;
let pendingPermissionId = null;
let pendingUnknownId = null;
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
process.stdin.on("data", (chunk) => {
  carry += chunk.toString();
  const lines = carry.split("\\n");
  carry = lines.pop();
  for (const line of lines) {
    if (!line.trim()) continue;
    const request = JSON.parse(line);
    if (request.method === undefined) {
      // A response to something we (the fake agent) asked the client.
      if (request.id === pendingPermissionId) {
        pendingPermissionId = null;
        send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "devin-session", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "permission=" + JSON.stringify(request.result) } } } });
        send({ jsonrpc: "2.0", id: promptRequestId, result: { stopReason: "end_turn" } });
      } else if (request.id === pendingUnknownId) {
        pendingUnknownId = null;
        send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "devin-session", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "error=" + JSON.stringify(request.error) } } } });
        send({ jsonrpc: "2.0", id: promptRequestId, result: { stopReason: "end_turn" } });
      }
      continue;
    }
    if (request.method === "initialize") {
      initialized = request.params.protocolVersion === 1 && request.params.clientInfo.name === "bench";
      send({ jsonrpc: "2.0", id: request.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true }, authMethods: [] } });
    } else if (request.method === "session/new") {
      setup = request.params;
      // The "model" configOption, captured verbatim off the real binary
      // (#114) - always sent, whether or not a test cares, the same way the
      // real server hands it over unasked.
      send({ jsonrpc: "2.0", id: request.id, result: { sessionId: "devin-session", configOptions: [{ id: "model", name: "Model", type: "select", currentValue: "swe-2-high", options: [] }] } });
    } else if (request.method === "session/load") {
      setup = request.params;
      send({ jsonrpc: "2.0", id: request.id, result: null });
    } else if (request.method === "session/prompt") {
      prompts += 1;
      promptRequestId = request.id;
      const text = request.params.prompt.find((block) => block.type === "text").text;
      if (mode === "die") {
        process.stderr.write("ACP child died during prompt\\n");
        process.exit(7);
      }
      if (mode === "silent") {
        // Accepts the prompt and never says another word - the #116 repro.
        continue;
      }
      if (mode === "permission") {
        pendingPermissionId = 555;
        send({ jsonrpc: "2.0", id: pendingPermissionId, method: "session/request_permission", params: { sessionId: "devin-session", options: [
          { optionId: "reject-once", name: "Reject", kind: "reject_once" },
          { optionId: "allow-once", name: "Allow", kind: "allow_once" },
        ] } });
        continue;
      }
      if (mode === "unknown-request") {
        pendingUnknownId = 777;
        send({ jsonrpc: "2.0", id: pendingUnknownId, method: "fs/read_text_file", params: { path: "/tmp/x" } });
        continue;
      }
      const answer = mode === "inspect"
        ? JSON.stringify({ initialized, setup, cwd: process.cwd(), text, devinModelEnv: process.env.DEVIN_MODEL ?? null })
        : text + "|received=" + prompts;
      const finish = () => {
        send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "devin-session", update: { sessionUpdate: "tool_call", title: "Editing file", status: "in_progress" } } });
        // The real wire shape, captured by driving actual Devin turns (#115
        // review comments) - flat "used"/"size" on the notification, not a
        // nested "usage.totalTokens"; "used" is the *conversation's*
        // cumulative occupancy, not the turn's own spend, and the result's
        // "usage.totalTokens" agrees with the last "used" of the same turn.
        // "usage" models a fresh session's first two turns: turn one moves
        // used 0 -> 100 -> 250 across two updates; turn two, on the same
        // conversation, moves it 250 -> 295 across one.
        if (mode === "usage" && prompts === 1) {
          send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "devin-session", update: { sessionUpdate: "usage_update", used: 100, size: 262000, _meta: { "cognition.ai/inputTokens": 90, "cognition.ai/outputTokens": 10 } } } });
          send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "devin-session", update: { sessionUpdate: "usage_update", used: 250, size: 262000, _meta: { "cognition.ai/inputTokens": 200, "cognition.ai/outputTokens": 50 } } } });
        } else if (mode === "usage" && prompts === 2) {
          send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "devin-session", update: { sessionUpdate: "usage_update", used: 295, size: 262000, _meta: { "cognition.ai/inputTokens": 290, "cognition.ai/outputTokens": 5 } } } });
        } else if (mode === "usage-resume" && prompts === 1) {
          // A session resumed from a prior process: "used" starts already
          // high - the conversation this session is resuming already spent
          // tokens this process never saw a baseline for.
          send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "devin-session", update: { sessionUpdate: "usage_update", used: 5000, size: 262000 } } });
          send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "devin-session", update: { sessionUpdate: "usage_update", used: 5200, size: 262000 } } });
        } else if (mode === "usage-resume" && prompts === 2) {
          send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "devin-session", update: { sessionUpdate: "usage_update", used: 5240, size: 262000 } } });
        }
        send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "devin-session", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: answer } } } });
        const usageResult = mode === "usage"
          ? (prompts === 1 ? { totalTokens: 250, inputTokens: 200, outputTokens: 50 } : { totalTokens: 295, inputTokens: 290, outputTokens: 5 })
          : mode === "usage-resume"
          ? (prompts === 1 ? { totalTokens: 5200, inputTokens: 5150, outputTokens: 50 } : { totalTokens: 5240, inputTokens: 5230, outputTokens: 10 })
          : null;
        const result = usageResult
          ? { stopReason: "end_turn", usage: usageResult }
          : { stopReason: mode === "refusal" ? "refusal" : "end_turn" };
        send({ jsonrpc: "2.0", id: request.id, result });
      };
      if (mode === "slow") setTimeout(finish, 150); else finish();
    }
  }
});
`;

/**
 * A fake that advertises an auth method, so the session has to authenticate
 * before session/new. It reports back the api_key it was handed, verbatim.
 */
const ACP_AUTH = `#!/usr/bin/env node
let carry = "";
let key = null;
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
process.stdin.on("data", (chunk) => {
  carry += chunk.toString();
  const lines = carry.split("\\n");
  carry = lines.pop();
  for (const line of lines) {
    if (!line.trim()) continue;
    const request = JSON.parse(line);
    if (request.method === "initialize") {
      send({ jsonrpc: "2.0", id: request.id, result: { protocolVersion: 1, authMethods: [{ id: "devin-browser" }] } });
    } else if (request.method === "authenticate") {
      key = request.params._meta.api_key;
      send({ jsonrpc: "2.0", id: request.id, result: {} });
    } else if (request.method === "session/new") {
      send({ jsonrpc: "2.0", id: request.id, result: { sessionId: "devin-session" } });
    } else if (request.method === "session/prompt") {
      send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "devin-session", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "key=" + key } } } });
      send({ jsonrpc: "2.0", id: request.id, result: { stopReason: "end_turn" } });
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

  it("passes the chosen family to devin acp via DEVIN_MODEL (#114)", async () => {
    const session = await makeSession("inspect", { model: "adaptive" });
    session.open();
    const result = await turn(session, "hello");
    expect(JSON.parse(result.result).devinModelEnv).toBe("adaptive");
    session.stop();
  });

  it("leaves DEVIN_MODEL unset for the bare account default", async () => {
    // No `model` option at all - `devinFamilyOf` returns undefined for a
    // bare `devin` id, and an unset DEVIN_MODEL is what leaves `devin acp`
    // on the account's own default.
    const session = await makeSession("inspect");
    session.open();
    const result = await turn(session, "hello");
    expect(JSON.parse(result.result).devinModelEnv).toBeNull();
    session.stop();
  });

  it("reports what the session actually resolved to, off configOptions (#114)", async () => {
    // The picker offers "adaptive", a family; this is what the session
    // actually ran the turn on, captured off the real binary's own
    // configOptions the way the ticket's evidence showed it.
    const session = await makeSession("clean", { model: "adaptive" });
    session.open();
    expect(session.turnAnsweredBy).toEqual([]);
    await turn(session, "hello");
    expect(session.turnAnsweredBy).toEqual(["swe-2-high"]);
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
    expect(result).not.toHaveProperty("usage");
    expect(session.contextUsed).toBeNull();
    expect(session.turnTokens).toBe(0);
    expect(session.turnGenerationIds).toEqual([]);
    // Not [] any more (#114): turnAnsweredBy now carries what the session
    // actually resolved to, off the fake server's own configOptions - every
    // clean-mode session gets one, the same as the real binary always does.
    expect(session.turnAnsweredBy).toEqual(["swe-2-high"]);
    session.stop();
  });

  it("moves turnTokens live off usage_update's 'used' field, as this turn's own spend, and carries the result's cumulative usage onto the ResultEvent", async () => {
    const session = await makeSession("usage");
    const progressTokens: number[] = [];
    session.on("progress", () => progressTokens.push(session.turnTokens));
    session.open();
    const result = await turn(session, "work");

    // A fresh session's first turn: the baseline is 0, so the turn's own
    // spend and the conversation's cumulative "used" coincide here - this
    // is exactly the capture that made round two's mistake possible.
    expect(progressTokens).toEqual([100, 250]);
    expect(session.turnTokens).toBe(250);
    expect(result.usage).toEqual({ totalTokens: 250, inputTokens: 200, outputTokens: 50 });
    expect(result).not.toHaveProperty("total_cost_usd");
    session.stop();
  });

  it("computes contextUsed from usage_update's used/size, and leaves it alone once a turn ends", async () => {
    const session = await makeSession("usage");
    session.open();
    expect(session.contextUsed).toBeNull();
    await turn(session, "work");

    expect(session.contextUsed).toEqual({ used: 250, window: 262000 });
    session.stop();
  });

  it("reports the second turn's own spend, not the conversation, and contextUsed keeps growing", async () => {
    // The defect round three actually found: a second, distinct turn on the
    // same session must not read as the whole conversation so far.
    const session = await makeSession("usage");
    session.open();
    await turn(session, "first");
    expect(session.turnTokens).toBe(250);
    expect(session.contextUsed).toEqual({ used: 250, window: 262000 });

    const midTurnTokens: number[] = [];
    session.on("progress", () => midTurnTokens.push(session.turnTokens));
    const result = await turn(session, "second");

    // used moves 250 -> 295 across turn two; turnTokens reports the 45-token
    // difference, never the conversation's 295.
    expect(midTurnTokens).toEqual([45]);
    expect(session.turnTokens).toBe(45);
    expect(result.usage).toEqual({ totalTokens: 295, inputTokens: 290, outputTokens: 5 });
    expect(session.contextUsed).toEqual({ used: 295, window: 262000 });
    session.stop();
  });

  it("does not report a resumed session's first turn as its own spend, but recovers on the second", async () => {
    // A resumed session has no in-process memory of what "used" was before
    // it started - so its first turn's baseline is genuinely unknown, and
    // reporting a number here would repeat the exact defect this round
    // found, just gated behind a resume instead of a second turn.
    const session = await makeSession("usage-resume", { resumeSessionId: "devin-persisted" });
    session.open();
    const first = await turn(session, "first");

    // turnTokens stays 0 - the honest "unknown" this codebase already uses
    // for "nothing has updated it yet" - rather than the conversation's
    // 5200. The result's own usage block is still carried, cumulative and
    // unadjusted, exactly as documented: nothing here invents a delta it
    // cannot back.
    expect(session.turnTokens).toBe(0);
    expect(first.usage).toEqual({ totalTokens: 5200, inputTokens: 5150, outputTokens: 50 });
    expect(session.contextUsed).toEqual({ used: 5200, window: 262000 });

    // Turn two now has a real baseline, carried over from turn one's own
    // usage_update - the gap is exactly one turn wide, never permanent.
    const second = await turn(session, "second");
    expect(session.turnTokens).toBe(40);
    expect(second.usage).toEqual({ totalTokens: 5240, inputTokens: 5230, outputTokens: 10 });
    expect(session.contextUsed).toEqual({ used: 5240, window: 262000 });
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

  it("declares a turn stalled after silence since the agent's last message, not after total turn duration (#116)", async () => {
    const session = await makeSession("silent", { stallTimeoutMs: 80 });
    const exited = once(session, "exit");
    session.open();
    session.send("work");
    const [code, stderr] = await exited;
    expect(code).toBeNull();
    expect(stderr).toMatch(/went silent.*stalled/i);
  });

  it("answers session/request_permission instead of dropping it (#116)", async () => {
    const session = await makeSession("permission");
    session.open();
    const result = await turn(session, "work");
    expect(result.result).toContain('"outcome":"selected"');
    expect(result.result).toContain('"optionId":"allow-once"');
    session.stop();
  });

  it("answers an unrecognized inbound request with a JSON-RPC error instead of silence (#116)", async () => {
    const session = await makeSession("unknown-request");
    session.open();
    const result = await turn(session, "work");
    expect(result.result).toContain('"code":-32601');
    session.stop();
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

  it("writes .devin/hooks.v1.json into the worktree and git-excludes it", async () => {
    const worktree = await mkdtemp(join(tmpdir(), "bench-devin-wt-"));
    spawnSync("git", ["init"], { cwd: worktree });
    const session = await makeSession("clean", { worktree, hookCommand: "node /opt/bench/hook.js" });
    session.open();

    const hooks = JSON.parse(await readFile(join(worktree, ".devin", "hooks.v1.json"), "utf8"));
    expect(hooks).toEqual({
      PreToolUse: [{
        matcher: "exec",
        hooks: [{ type: "command", command: "node /opt/bench/hook.js commit-attribution" }],
      }],
    });

    const commonDir = String(spawnSync("git", ["-C", worktree, "rev-parse", "--path-format=absolute", "--git-common-dir"]).stdout).trim();
    const exclude = await readFile(join(commonDir, "info", "exclude"), "utf8");
    expect(exclude.split("\n")).toContain(".devin/hooks.v1.json");
    // Excluded, so the specialist's own diff never carries it.
    expect(String(spawnSync("git", ["-C", worktree, "status", "--porcelain"]).stdout)).toBe("");
    session.stop();
  });

  it("leaves a project-tracked .devin/hooks.v1.json alone", async () => {
    const worktree = await mkdtemp(join(tmpdir(), "bench-devin-wt-"));
    spawnSync("git", ["init"], { cwd: worktree });
    const hooksPath = join(worktree, ".devin", "hooks.v1.json");
    await mkdir(join(worktree, ".devin"), { recursive: true });
    await writeFile(hooksPath, `{"the":"project's own"}\n`);
    spawnSync("git", ["-C", worktree, "add", ".devin/hooks.v1.json"]);

    const session = await makeSession("clean", { worktree, hookCommand: "node /opt/bench/hook.js" });
    const exited = once(session, "exit");
    session.open();

    expect(await readFile(hooksPath, "utf8")).toBe(`{"the":"project's own"}\n`);
    session.stop();
    const [, stderr] = await exited;
    expect(stderr).toContain("tracked in this repo");
  });

  it("passes WINDSURF_API_KEY to authenticate ahead of the credentials file", async () => {
    const devinBin = await executable(ACP_AUTH, "fake-devin.mjs");
    const worktree = await mkdtemp(join(tmpdir(), "bench-devin-wt-"));
    const previous = process.env.WINDSURF_API_KEY;
    process.env.WINDSURF_API_KEY = "env-key-123";
    try {
      const session = new DevinSession({ id: "bench-session", worktree, reportsDir: join(worktree, ".bench", "reports", "bench-session"), devinBin });
      session.open();
      const result = await turn(session, "hello");
      expect(result.result).toBe("key=env-key-123");
      session.stop();
    } finally {
      if (previous === undefined) delete process.env.WINDSURF_API_KEY;
      else process.env.WINDSURF_API_KEY = previous;
    }
  });
});
