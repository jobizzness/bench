import { once } from "node:events";
import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runtimeFor } from "../src/daemon/session.js";
import { fellBack } from "../src/shared/role-models.js";
import { ROLES } from "../src/shared/roles.js";
import { SessionRegistry } from "../src/daemon/registry.js";
import { SessionStore } from "../src/daemon/store.js";

/**
 * A minimal fake ACP server that records which setup method was used
 * (session/new vs session/load) and which session id was passed, then
 * answers one prompt and stays up.
 */
const FAKE_ACP = `#!/usr/bin/env node
let carry = "";
const send = (v) => process.stdout.write(JSON.stringify(v) + "\\n");
process.stdin.on("data", (chunk) => {
  carry += chunk.toString();
  const lines = carry.split("\\n");
  carry = lines.pop();
  for (const line of lines) {
    if (!line.trim()) continue;
    const req = JSON.parse(line);
    if (req.method === "initialize") {
      send({ jsonrpc: "2.0", id: req.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true }, authMethods: [] } });
    } else if (req.method === "session/new") {
      send({ jsonrpc: "2.0", id: req.id, result: { sessionId: "acp-fresh" } });
    } else if (req.method === "session/load") {
      // Echo the requested session id back so the test can verify it.
      send({ jsonrpc: "2.0", id: req.id, result: { sessionId: req.params.sessionId } });
    } else if (req.method === "session/prompt") {
      const sessionId = req.params.sessionId;
      send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "ok" } } } });
      send({ jsonrpc: "2.0", id: req.id, result: { stopReason: "end_turn" } });
    }
  }
});
`;

async function fakeBin(source: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "bench-rt-test-"));
  const path = join(dir, "fake-devin.mjs");
  await writeFile(path, source);
  await chmod(path, 0o755);
  return path;
}

async function makeRegistry(over: Record<string, unknown> = {}) {
  const home = await mkdtemp(join(tmpdir(), "bench-home-"));
  const project = await mkdtemp(join(tmpdir(), "bench-proj-"));
  const worktree = join(project, ".claude", "worktrees", "tab");
  await mkdir(worktree, { recursive: true });

  const id = "sess-devin-rt";
  const reportsDir = join(project, ".bench", "reports", id);
  await mkdir(reportsDir, { recursive: true });

  return { home, project, worktree, id, reportsDir };
}

describe("runtimeFor", () => {
  it("returns 'devin' for the devin model", () => {
    expect(runtimeFor("devin")).toBe("devin");
  });

  it("returns 'devin' for a namespaced Devin model (#114)", () => {
    expect(runtimeFor("devin:adaptive")).toBe("devin");
    expect(runtimeFor("devin:opus")).toBe("devin");
    expect(runtimeFor("devin:swe-2")).toBe("devin");
  });

  it("returns 'claude' for Anthropic aliases", () => {
    for (const id of ["opus", "sonnet", "fable", "haiku"]) {
      expect(runtimeFor(id)).toBe("claude");
    }
  });

  it("returns 'claude' for OpenRouter models", () => {
    expect(runtimeFor("google/gemini-3.7-flash")).toBe("claude");
    expect(runtimeFor("openai/gpt-5")).toBe("claude");
  });
});

describe("fellBack does not trigger for devin", () => {
  it("is false for every role with devin chosen, even with no OpenRouter key", () => {
    // Devin is a local runtime — not proxied, not lacking a key.
    // fellBack is for proxied models with no key; it must never affect Devin.
    for (const role of ROLES) {
      expect(fellBack(role, { chosen: "devin", viaRouter: false }), role).toBe(false);
      expect(fellBack(role, { chosen: "devin:adaptive", viaRouter: false }), role).toBe(false);
    }
  });
});

describe("revive uses DevinSession for a devin specialist", () => {
  it("calls session/load with the persisted ACP session id on revival", async () => {
    const { home, project, worktree, id, reportsDir } = await makeRegistry();
    const devinBin = await fakeBin(FAKE_ACP);

    const store = new SessionStore(home);
    await store.put({
      id, label: "tab", project, worktree, branch: "bench/tab-abcd1234", reportsDir,
      model: "devin", port: 3199, createdAt: new Date().toISOString(),
      runtimeSessionId: "saved-acp-id", resumable: true,
    });

    const config = {
      home, port: 7499, token: "t",
      pluginDir: "/nonexistent/plugin",
      hookCommand: "node /nonexistent/hook.js",
      projectsRoot: project,
      devinBin,
    };

    const registry = new SessionRegistry(config as any);
    await registry.restore();

    // Delivering a message triggers revive → attach → DevinSession.open().
    // The fake ACP server stays alive and answers one turn.
    const ended = once(registry, "roster");
    registry.send(id, "wake up");

    // Let the session run through open → initialize → session/load → prompt.
    await new Promise<void>((resolve) => {
      const check = () => {
        const row = registry.list().find((r) => r.id === id);
        if (row && (row.status === "working" || row.status === "awaiting_decision")) {
          resolve();
        }
      };
      registry.on("roster", check);
      check();
    });

    // The ACP server echoes the sessionId it received in session/load.
    // After the turn ends the session_id on the result should be "saved-acp-id".
    // Wait for the specialist to finish its turn.
    await new Promise<void>((resolve) => {
      const check = () => {
        const row = registry.list().find((r) => r.id === id);
        if (row && row.status !== "working") resolve();
      };
      registry.on("roster", check);
      check();
    });

    // The row should show the devin model and not be crashed.
    const row = registry.list().find((r) => r.id === id)!;
    expect(row.model).toBe("devin");
    expect(row.status).not.toBe("crashed");
    // No cost: spend is null, tokens is 0 (formatTokens(0) returns null).
    expect(row.spend).toBeNull();
    expect(row.tokens).toBe(0);

    void ended;
  });
});
