import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runtimeFor } from "../src/daemon/session.js";
import { fellBack } from "../src/shared/role-models.js";
import { ROLES } from "../src/shared/roles.js";
import { SessionRegistry } from "../src/daemon/registry.js";
import { SessionStore } from "../src/daemon/store.js";
import { AGY_MODEL, ANTIGRAVITY_MODEL, ANTIGRAVITY_PREFIX } from "../src/shared/models.js";

/**
 * A minimal fake `agy` binary that speaks `--input-format stream-json --output-format stream-json`.
 * It emits an `init` event, then on reading a user prompt line, emits a `step_update` and a `result`.
 */
const FAKE_AGY = `#!/usr/bin/env node
let carry = "";
const send = (v) => process.stdout.write(JSON.stringify(v) + "\\n");

// Emit init event immediately
send({ event: "init", conversation_id: "agy-conv-1234" });

process.stdin.on("data", (chunk) => {
  carry += chunk.toString();
  const lines = carry.split("\\n");
  carry = lines.pop();
  for (const line of lines) {
    if (!line.trim()) continue;
    const req = JSON.parse(line);
    if (req.event === "user") {
      // Emit a tool activity step
      send({
        event: "step_update",
        step_update: {
          step_type: "tool_call",
          tool_name: "run_command",
          tool_info: { command: "git status" },
          usage: { input_tokens: 150, output_tokens: 50, total_tokens: 200 },
        },
      });
      // Emit the turn result
      send({
        event: "result",
        conversation_id: "agy-conv-1234",
        status: "SUCCESS",
        response: "All changes committed.",
        usage: {
          input_tokens: 200,
          output_tokens: 80,
          total_tokens: 280,
          cache_read_tokens: 20,
        },
      });
    }
  }
});
`;

async function fakeBin(source: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "bench-agy-rt-test-"));
  const path = join(dir, "fake-agy.mjs");
  await writeFile(path, source);
  await chmod(path, 0o755);
  return path;
}

async function makeRegistry() {
  const home = await mkdtemp(join(tmpdir(), "bench-home-"));
  const project = await mkdtemp(join(tmpdir(), "bench-proj-"));
  const worktree = join(project, ".claude", "worktrees", "tab");
  await mkdir(worktree, { recursive: true });

  const id = "sess-agy-rt";
  const reportsDir = join(project, ".bench", "reports", id);
  await mkdir(reportsDir, { recursive: true });

  return { home, project, worktree, id, reportsDir };
}

describe("runtimeFor for Antigravity", () => {
  it("returns 'antigravity' for agy and antigravity", () => {
    expect(runtimeFor(AGY_MODEL)).toBe("antigravity");
    expect(runtimeFor(ANTIGRAVITY_MODEL)).toBe("antigravity");
  });

  it("returns 'antigravity' for namespaced models", () => {
    expect(runtimeFor("agy:gemini-3.8-flash-high")).toBe("antigravity");
    expect(runtimeFor("antigravity:claude-opus-5-5-high")).toBe("antigravity");
  });
});

describe("fellBack does not trigger for Antigravity", () => {
  it("is false for every role with Antigravity chosen, even with no OpenRouter key", () => {
    for (const role of ROLES) {
      expect(fellBack(role, { chosen: "agy", viaRouter: false }), role).toBe(false);
      expect(fellBack(role, { chosen: "agy:gemini-3.8-flash-high", viaRouter: false }), role).toBe(false);
    }
  });
});

describe("revive uses AntigravitySession for an agy specialist", () => {
  it("spawns agy, parses stream-json events, and completes a turn", async () => {
    const { home, project, worktree, id, reportsDir } = await makeRegistry();
    const agyBin = await fakeBin(FAKE_AGY);

    const store = new SessionStore(home);
    await store.put({
      id, label: "tab", project, worktree, branch: "bench/tab-abcd1234", reportsDir,
      model: "agy:gemini-3.8-flash-high", port: 3198, createdAt: new Date().toISOString(),
      runtimeSessionId: "agy-conv-1234", resumable: true,
    });

    const config = {
      home, port: 7498, token: "t",
      pluginDir: "/nonexistent/plugin",
      hookCommand: "node /nonexistent/hook.js",
      projectsRoot: project,
      agyBin,
    };

    const registry = new SessionRegistry(config as any);
    await registry.restore();

    registry.send(id, "run git status");

    // Wait for the specialist to finish its turn
    await new Promise<void>((resolve) => {
      const check = () => {
        const row = registry.list().find((r) => r.id === id);
        if (row && row.status !== "working") resolve();
      };
      registry.on("roster", check);
      check();
    });

    const row = registry.list().find((r) => r.id === id)!;
    expect(row.model).toBe("agy:gemini-3.8-flash-high");
    expect(row.status).not.toBe("crashed");
    expect(row.tokens).toBe(280);
    // Local runtime has no per-turn spend in Bench
    expect(row.spend).toBeNull();
  });
});
