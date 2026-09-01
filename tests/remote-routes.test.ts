import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, cp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createServer } from "../src/daemon/server.js";
import type { RemoteControllerLike } from "../src/daemon/remote/controller.js";
import { REMOTE_OFF, type RemoteState } from "../src/shared/remote.js";
import type { RosterRow } from "../src/shared/types.js";

const TOKEN = "test-token-remote";

/** The registry stub every route in server.ts needs present to boot, trimmed
 * to what these tests never touch. */
class StubRegistry extends EventEmitter {
  list(): RosterRow[] { return []; }
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
  get() { return null; }
  send() {}
  async close() { return { closed: true, changes: 0, unmergedCommits: 0 }; }
  stop() {}
  clearContext() { return false; }
  rename() { return false; }
  async setModel() {}
  async setReasoningEffort() {}
  async setRole() {}
  async create() { return "s1"; }
  async dispatch() {}
  decline() {}
}

class StubRemote implements RemoteControllerLike {
  current: RemoteState = REMOTE_OFF;
  connected: Array<{ refreshToken: string; uid: string; email?: string }> = [];
  renamed: string[] = [];
  disconnectCalled = 0;
  failConnectWith: string | null = null;
  failRenameWith: string | null = null;

  state() { return this.current; }
  async connect(refreshToken: string, uid: string, email?: string) {
    if (this.failConnectWith) throw new Error(this.failConnectWith);
    this.connected.push({ refreshToken, uid, email });
    this.current = { ...REMOTE_OFF, connected: true, uid, email: email ?? null, machineId: "m1", machineName: "laptop", tokenExpiresAt: Date.now() + 3_600_000 };
    return this.current;
  }
  async disconnect() {
    this.disconnectCalled += 1;
    this.current = REMOTE_OFF;
    return this.current;
  }
  async renameMachine(name: string) {
    if (this.failRenameWith) throw new Error(this.failRenameWith);
    this.renamed.push(name);
    this.current = { ...this.current, machineName: name };
    return this.current;
  }
}

let server: ReturnType<typeof createServer>;
let base: string;
let remote: StubRemote;
const auth = { headers: { "x-bench-token": TOKEN } };

beforeAll(async () => {
  remote = new StubRemote();
  const projectsRoot = await mkdtemp(join(tmpdir(), "bench-remote-routes-proj-"));
  const clientDir = await mkdtemp(join(tmpdir(), "bench-remote-routes-client-"));
  await cp("src/client", clientDir, { recursive: true });
  await writeFile(join(clientDir, "app.js"), "/* built bundle */\n");
  await writeFile(join(clientDir, "sw.js"), "/* built worker */\n");
  await mkdir(projectsRoot, { recursive: true });

  server = createServer({
    config: { home: "/tmp/bench-remote-routes", port: 0, token: TOKEN, pluginDir: "/tmp/plugin", hookCommand: "node hook.js", projectsRoot } as any,
    registry: new StubRegistry() as any,
    clientDir,
    remote,
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => { server.close(); });

describe("GET /api/remote", () => {
  it("refuses a request with no token, same as every other route", async () => {
    const res = await fetch(`${base}/api/remote`);
    expect(res.status).toBe(401);
  });

  it("reports off when nothing has connected", async () => {
    const res = await fetch(`${base}/api/remote`, auth);
    expect(res.status).toBe(200);
    expect((await res.json()).connected).toBe(false);
  });

  it("reports what the controller says once connected", async () => {
    await remote.connect("rt", "u1", "dev@example.com");
    const res = await fetch(`${base}/api/remote`, auth);
    const body = await res.json();
    expect(body.connected).toBe(true);
    expect(body.uid).toBe("u1");
    expect(body.email).toBe("dev@example.com");
    await remote.disconnect();
  });
});

describe("POST /api/remote/identity", () => {
  it("hands the refresh token and uid to the controller", async () => {
    const res = await fetch(`${base}/api/remote/identity`, {
      method: "POST",
      headers: { ...auth.headers, "content-type": "application/json" },
      body: JSON.stringify({ refreshToken: "rt-abc", uid: "u9" }),
    });
    expect(res.status).toBe(200);
    expect(remote.connected.at(-1)).toEqual({ refreshToken: "rt-abc", uid: "u9", email: undefined });
    expect((await res.json()).connected).toBe(true);
    await remote.disconnect();
  });

  it("refuses a body missing either field", async () => {
    const res = await fetch(`${base}/api/remote/identity`, {
      method: "POST",
      headers: { ...auth.headers, "content-type": "application/json" },
      body: JSON.stringify({ refreshToken: "rt-abc" }),
    });
    expect(res.status).toBe(400);
  });

  it("answers 400 with the controller's message when the exchange fails", async () => {
    remote.failConnectWith = "refresh token was rejected: 400";
    const res = await fetch(`${base}/api/remote/identity`, {
      method: "POST",
      headers: { ...auth.headers, "content-type": "application/json" },
      body: JSON.stringify({ refreshToken: "dead", uid: "u1" }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("rejected");
    remote.failConnectWith = null;
  });
});

describe("DELETE /api/remote", () => {
  it("turns remote off and reports the result", async () => {
    await remote.connect("rt", "u1");
    const res = await fetch(`${base}/api/remote`, { method: "DELETE", headers: auth.headers });
    expect(res.status).toBe(200);
    expect(remote.disconnectCalled).toBeGreaterThan(0);
    expect((await res.json()).connected).toBe(false);
  });
});

describe("POST /api/remote/machine", () => {
  it("renames the machine", async () => {
    await remote.connect("rt", "u1");
    const res = await fetch(`${base}/api/remote/machine`, {
      method: "POST",
      headers: { ...auth.headers, "content-type": "application/json" },
      body: JSON.stringify({ name: "kitchen table" }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).machineName).toBe("kitchen table");
    await remote.disconnect();
  });

  it("refuses an empty name", async () => {
    const res = await fetch(`${base}/api/remote/machine`, {
      method: "POST",
      headers: { ...auth.headers, "content-type": "application/json" },
      body: JSON.stringify({ name: "  " }),
    });
    expect(res.status).toBe(400);
  });
});

describe("a daemon with no remote controller wired up at all", () => {
  it("still boots and answers /api/remote as off - the default from createServer's own opts", async () => {
    const bare = createServer({
      config: { home: "/tmp/bench-bare", port: 0, token: TOKEN, pluginDir: "/tmp/plugin", hookCommand: "node hook.js", projectsRoot: "/tmp" } as any,
      registry: new StubRegistry() as any,
      clientDir: await mkdtemp(join(tmpdir(), "bench-bare-client-")),
    });
    await new Promise<void>((resolve) => bare.listen(0, "127.0.0.1", resolve));
    const bareBase = `http://127.0.0.1:${(bare.address() as AddressInfo).port}`;

    const res = await fetch(`${bareBase}/api/remote`, auth);
    expect(res.status).toBe(200);
    expect((await res.json()).connected).toBe(false);

    bare.close();
  });
});
