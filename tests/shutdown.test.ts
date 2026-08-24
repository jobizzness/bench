import { describe, it, expect } from "vitest";
import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import WebSocket from "ws";
import { createServer } from "../src/daemon/server.js";

/**
 * Stopping the daemon.
 *
 * `server.close()` stops listening and then waits for every connection to
 * end. The cockpit's roster socket does not end - it is open for as long as
 * the tab is - so the callback never came, Ctrl-C looked like it had done
 * nothing, and the developer killed a daemon that was still holding the
 * port. The next one started beside a specialist that was still running.
 * Two of those ended up writing one index between them.
 */

class StubRegistry extends EventEmitter {
  list() { return []; }
  get() { return null; }
  send() {}
  stop() {}
  async close() { return { closed: true, changes: 0, unmergedCommits: 0 }; }
  async create() { return "s1"; }
}

const TOKEN = "shutdown-token";

async function boot() {
  const server = createServer({
    config: {
      home: "/tmp/bench", port: 0, token: TOKEN,
      pluginDir: "/tmp/plugin", hookCommand: "node hook.js", projectsRoot: "/tmp",
    },
    registry: new StubRegistry() as any,
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { server, port };
}

/** Resolves true if the server finished closing, false if it hung. */
function closes(server: ReturnType<typeof createServer>, within: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), within);
    server.close(() => { clearTimeout(timer); resolve(true); });
  });
}

async function connected(port: number): Promise<WebSocket> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/events?token=${TOKEN}`);
  await new Promise((resolve) => socket.on("message", resolve));
  return socket;
}

describe("stopping a daemon a cockpit is watching", () => {
  it("finishes closing, rather than waiting on a socket that never ends", async () => {
    const { server, port } = await boot();
    const socket = await connected(port);

    server.closeSockets();
    expect(await closes(server, 1500)).toBe(true);

    socket.terminate();
  });

  it("exits on ctrl-c with a cockpit connected", async () => {
    // The one that matters, and the one the other two are in service of.
    // A daemon that will not exit is a daemon that gets killed, and a killed
    // daemon leaves its lock, its children and - twice now - an index with
    // two writes inside it.
    const home = await mkdtemp(join(tmpdir(), "bench-shutdown-"));
    // node directly, not npx: a signal sent to the wrapper never reaches
    // the process under it, and the test would be measuring npm.
    const daemon = spawn(
      process.execPath,
      ["--import", "tsx", "src/daemon/index.ts"],
      { env: { ...process.env, BENCH_HOME: home, BENCH_PORT: "3199" }, stdio: ["ignore", "pipe", "pipe"] },
    );

    const url = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("the daemon never printed a URL")), 30_000);
      daemon.stdout.on("data", (chunk: Buffer) => {
        const line = String(chunk).split("\n").find((l) => l.includes("http://"));
        if (line) { clearTimeout(timer); resolve(line.replace("bench: ", "").trim()); }
      });
    });

    const socket = new WebSocket(url.replace("http://", "ws://").replace(/\/\?token=/, "/events?token="));
    await new Promise((resolve) => socket.on("message", resolve));

    const exited = new Promise<number>((resolve) => {
      const started = performance.now();
      const timer = setTimeout(() => resolve(Infinity), 8000);
      daemon.on("exit", () => { clearTimeout(timer); resolve(performance.now() - started); });
    });
    daemon.kill("SIGINT");

    // Under the two-second fallback, deliberately. The daemon has a timer
    // that ends it whatever happens, so "it exited" on its own proves only
    // that the timer works; what this asks is whether it finished.
    expect(await exited).toBeLessThan(1500);
    socket.terminate();
  }, 60_000);

  it("tells the cockpit it is going, so an open tab reconnects later", async () => {
    // 1001 is "going away". A refusal would make the page give up and say
    // the link is stale, which is a different problem with a different fix.
    const { server, port } = await boot();
    const socket = await connected(port);

    const closed = new Promise<number>((resolve) => socket.on("close", (code) => resolve(code)));
    server.closeSockets();

    expect(await closed).toBe(1001);
    await closes(server, 1500);
  });
});
