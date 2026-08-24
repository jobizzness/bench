import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import WebSocket from "ws";
import { createServer } from "../src/daemon/server.js";
import { SessionRegistry } from "../src/daemon/registry.js";
import { SessionStore } from "../src/daemon/store.js";
import { RefIndex } from "../src/daemon/refs.js";

/**
 * The whole chain a rename actually travels: the route, the registry, the
 * file the next daemon reads, and the socket the cockpit is listening on.
 *
 * The pieces each had a test and the feature still could have been broken -
 * a rename that never reaches the socket leaves the roster row saying the
 * old name until the page is reloaded, and nothing further down would have
 * noticed.
 */
const TOKEN = "rename-token";
const NEW_NAME = "Safari drops the session cookie";

let base: string;
let socketUrl: string;
let server: ReturnType<typeof createServer>;
let home: string;
let sessions: string;
let config: any;

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), "bench-live-home-"));
  const project = await mkdtemp(join(tmpdir(), "bench-live-proj-"));
  const worktree = join(project, ".claude", "worktrees", "auth");
  const reportsDir = join(project, ".bench", "reports", "s1");
  await mkdir(worktree, { recursive: true });
  await mkdir(reportsDir, { recursive: true });

  sessions = join(home, "sessions.json");
  await new SessionStore(home).put({
    id: "s1", label: "auth", role: "specialist", project, worktree,
    branch: "bench/auth-abcd1234", reportsDir, model: "opus", port: 3101,
    createdAt: "2026-08-24T00:00:00.000Z", isolated: true, resumable: true,
  });

  config = {
    home, host: "127.0.0.1", port: 0, token: TOKEN,
    pluginDir: "/nonexistent/plugin", hookCommand: "true", projectsRoot: project,
  };

  const registry = new SessionRegistry(config);
  await registry.restore();
  server = createServer({ config, registry, refs: new RefIndex() });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  base = `http://127.0.0.1:${port}`;
  socketUrl = `ws://127.0.0.1:${port}/events?token=${TOKEN}`;
});

afterAll(() => { server.close(); });

const rename = (id: string, label: string) =>
  fetch(`${base}/api/sessions/${id}/label`, {
    method: "POST",
    headers: { "x-bench-token": TOKEN, "content-type": "application/json" },
    body: JSON.stringify({ label }),
  });

describe("renaming through the daemon", () => {
  it("reaches the cockpit's socket, and the file the next daemon reads", async () => {
    const pushes: any[] = [];
    const socket = new WebSocket(socketUrl);
    socket.on("message", (raw) => pushes.push(JSON.parse(raw.toString())));
    await new Promise((r) => socket.once("open", r));
    await new Promise((r) => setTimeout(r, 50));
    pushes.length = 0;

    // Spaces included: what a person types is not what should be stored.
    const res = await rename("s1", `  ${NEW_NAME}  `);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ label: NEW_NAME });

    await new Promise((r) => setTimeout(r, 100));
    socket.close();

    const row = pushes.filter((m) => m.type === "roster").at(-1)?.rows?.[0];
    expect(row.label).toBe(NEW_NAME);
    // The name changed; nothing about where the work lives did.
    expect(row.branch).toBe("bench/auth-abcd1234");

    const record = JSON.parse(await readFile(sessions, "utf8"))[0];
    expect(record.label).toBe(NEW_NAME);
    expect(record.branch).toBe("bench/auth-abcd1234");

    const next = new SessionRegistry(config);
    await next.restore();
    expect(next.list()[0].label).toBe(NEW_NAME);
  });

  it("refuses an emptied name, an unknown specialist, and a request with no token", async () => {
    expect((await rename("s1", "   ")).status).toBe(400);
    expect((await rename("nobody", "hello")).status).toBe(404);

    const res = await fetch(`${base}/api/sessions/s1/label`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ label: "hello" }),
    });
    expect(res.status).toBe(401);

    const { rows } = await (await fetch(`${base}/api/roster`, { headers: { "x-bench-token": TOKEN } })).json();
    expect(rows[0].label).toBe(NEW_NAME);
  });
});
