import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import WebSocket from "ws";
import { createServer } from "../src/daemon/server.js";
import { SessionRegistry } from "../src/daemon/registry.js";
import { RefIndex } from "../src/daemon/refs.js";
import { waitFor } from "./helpers/wait-for.js";

/**
 * Pointing an editor at a project (#129).
 *
 * The developer opens VS Code themselves; this only tells the extension
 * which project to care about. The thing worth testing is that the cockpit
 * is never told it worked when nothing was listening - a button that
 * silently no-ops is how people stop trusting a feature.
 */
const TOKEN = "target-token";

let server: ReturnType<typeof createServer>;
let base: string;
let port: number;
const sockets: WebSocket[] = [];

beforeEach(async () => {
  const home = await mkdtemp(join(tmpdir(), "bench-target-home-"));
  const project = await mkdtemp(join(tmpdir(), "bench-target-proj-"));
  const config = {
    home, host: "127.0.0.1", port: 0, token: TOKEN,
    pluginDir: "/nonexistent/plugin", hookCommand: "true", projectsRoot: project,
  };
  const registry = new SessionRegistry(config as any);
  await registry.restore();
  server = createServer({ config, registry, refs: new RefIndex() } as any);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
  base = `http://127.0.0.1:${port}`;
});

afterEach(() => {
  for (const socket of sockets) socket.close();
  sockets.length = 0;
  server.close();
});

/** A connected client, and everything it has been sent. */
async function connect(as?: string) {
  const query = as === undefined ? "" : `&as=${as}`;
  const socket = new WebSocket(`ws://127.0.0.1:${port}/events?token=${TOKEN}${query}`);
  sockets.push(socket);
  const frames: any[] = [];
  socket.on("message", (raw) => frames.push(JSON.parse(raw.toString())));
  await new Promise((r) => socket.once("open", r));
  return { socket, frames };
}

const target = (project: string) =>
  fetch(`${base}/api/editor/target`, {
    method: "POST",
    headers: { "x-bench-token": TOKEN, "content-type": "application/json" },
    body: JSON.stringify({ project }),
  });

describe("targeting an editor at a project", () => {
  it("reaches an editor that is listening", async () => {
    const editor = await connect("editor");

    const res = await target("/var/www/bench");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ delivered: 1 });

    const frame = await waitFor(
      () => editor.frames.find((f) => f.type === "target"),
      "the target frame",
    );
    expect(frame.project).toBe("/var/www/bench");
  });

  /**
   * The failure mode the whole feature turns on. With nothing listening the
   * cockpit must be able to say so rather than drawing a tick.
   */
  it("says nothing was delivered when no editor is connected", async () => {
    const res = await target("/var/www/bench");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ delivered: 0 });
  });

  /** The cockpit is on the same socket and has no use for this. */
  it("does not send it to a cockpit", async () => {
    const cockpit = await connect();
    const editor = await connect("editor");

    await target("/var/www/bench");
    await waitFor(() => editor.frames.find((f) => f.type === "target"), "the target frame");

    expect(cockpit.frames.filter((f) => f.type === "target")).toHaveLength(0);
    // It is still a cockpit socket in every other way.
    expect(cockpit.frames.filter((f) => f.type === "roster").length).toBeGreaterThan(0);
  });

  it("reaches every editor that is listening", async () => {
    const one = await connect("editor");
    const two = await connect("editor");

    const res = await target("/var/www/bench");
    expect(await res.json()).toEqual({ delivered: 2 });

    await waitFor(() => one.frames.find((f) => f.type === "target"), "the first editor");
    await waitFor(() => two.frames.find((f) => f.type === "target"), "the second editor");
  });

  it("stops counting an editor that has gone away", async () => {
    const editor = await connect("editor");
    editor.socket.close();
    await waitFor(
      async () => ((await (await target("/var/www/bench")).json()).delivered === 0 ? true : null),
      "the closed editor to stop being counted",
    );
  });

  it("refuses a request that names no project", async () => {
    const res = await fetch(`${base}/api/editor/target`, {
      method: "POST",
      headers: { "x-bench-token": TOKEN, "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it("refuses without the token, like everything else", async () => {
    const res = await fetch(`${base}/api/editor/target`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ project: "/var/www/bench" }),
    });
    expect(res.status).toBe(401);
  });
});
