import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, cp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createServer } from "../src/daemon/server.js";

const TOKEN = "test-token-broadcast";

/** Trimmed to what `POST /api/sessions/:id/broadcast` actually touches:
 * whether the session exists, and recording calls to `setBroadcast`. */
class StubRegistry extends EventEmitter {
  broadcastCalls: Array<{ id: string; broadcast: boolean }> = [];
  sessions = new Set(["s1"]);

  list() { return []; }
  getSettings() { return { codingStyle: "", workflowRules: "", reviewModel: "sonnet", roleModels: {} }; }
  async saveSettings(input: unknown) { return input as any; }
  apiKeyState() { return { present: false, hint: "", enabled: true, origin: "", searched: [] }; }
  setApiKey() {}
  setApiKeyEnabled() {}
  clearApiKey() {}
  routerKeyState() { return { present: false, hint: "", origin: "", searched: [] }; }
  setRouterKey() {}
  clearRouterKey() {}
  async catalogue() { return []; }
  modelFor() { return "opus"; }
  async typicalTurn() { return { shape: null, turns: 0 }; }
  async spend() { return { plan: 0, account: 0, turns: 0, estimated: 0 }; }
  get(id: string) { return this.sessions.has(id) ? { reportsDir: "", threadPath: "", alive: false, revivable: false, model: "opus" } : null; }
  send() {}
  async close() { return { closed: true, changes: 0, unmergedCommits: 0 }; }
  stop() {}
  clearContext() { return false; }
  rename() { return false; }
  async setModel() {}
  async setReasoningEffort() {}
  async setRole() {}
  async setBroadcast(id: string, broadcast: boolean) { this.broadcastCalls.push({ id, broadcast }); }
  async create() { return "s1"; }
  async dispatch() {}
  decline() {}
}

let server: ReturnType<typeof createServer>;
let base: string;
let registry: StubRegistry;
const auth = { headers: { "x-bench-token": TOKEN } };

beforeAll(async () => {
  registry = new StubRegistry();
  const projectsRoot = await mkdtemp(join(tmpdir(), "bench-broadcast-route-proj-"));
  const clientDir = await mkdtemp(join(tmpdir(), "bench-broadcast-route-client-"));
  await cp("src/client", clientDir, { recursive: true });
  await writeFile(join(clientDir, "app.js"), "/* built bundle */\n");
  await writeFile(join(clientDir, "sw.js"), "/* built worker */\n");
  await mkdir(projectsRoot, { recursive: true });

  server = createServer({
    config: { home: "/tmp/bench-broadcast-route", port: 0, token: TOKEN, pluginDir: "/tmp/plugin", hookCommand: "node hook.js", projectsRoot } as any,
    registry: registry as any,
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => { server.close(); });

describe("POST /api/sessions/:id/broadcast", () => {
  it("turns broadcast on and reports it back", async () => {
    const res = await fetch(`${base}/api/sessions/s1/broadcast`, {
      method: "POST",
      headers: { ...auth.headers, "content-type": "application/json" },
      body: JSON.stringify({ broadcast: true }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).broadcast).toBe(true);
    expect(registry.broadcastCalls).toContainEqual({ id: "s1", broadcast: true });
  });

  it("404s for a session that does not exist", async () => {
    const res = await fetch(`${base}/api/sessions/nope/broadcast`, {
      method: "POST",
      headers: { ...auth.headers, "content-type": "application/json" },
      body: JSON.stringify({ broadcast: true }),
    });
    expect(res.status).toBe(404);
  });

  it("400s a non-boolean body", async () => {
    const res = await fetch(`${base}/api/sessions/s1/broadcast`, {
      method: "POST",
      headers: { ...auth.headers, "content-type": "application/json" },
      body: JSON.stringify({ broadcast: "yes" }),
    });
    expect(res.status).toBe(400);
  });

  it("refuses a request with no token, same as every other route", async () => {
    const res = await fetch(`${base}/api/sessions/s1/broadcast`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ broadcast: true }),
    });
    expect(res.status).toBe(401);
  });
});
