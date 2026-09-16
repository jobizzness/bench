import { describe, it, expect } from "vitest";
import { mkdtemp, writeFile, chmod, access } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findHeadroom, HeadroomProxy } from "../src/daemon/headroom.js";

/**
 * A stand-in for `headroom proxy`: parses --port and answers /health, the
 * one thing the daemon asks of it. Same pattern as FAKE_CLI in
 * claude-session.test.ts.
 */
const FAKE_HEADROOM = `#!/usr/bin/env node
const port = Number(process.argv[process.argv.indexOf("--port") + 1]);
require("node:http").createServer((req, res) => {
  res.writeHead(req.url === "/health" ? 200 : 404).end();
}).listen(port, "127.0.0.1");
`;

/** A proxy that says why it cannot, then dies - as a real one would. */
const DYING_HEADROOM = `#!/usr/bin/env node
process.stderr.write("boom\\n");
process.exit(1);
`;

async function makeBin(source: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "bench-headroom-"));
  const path = join(dir, "headroom");
  await writeFile(path, source);
  await chmod(path, 0o755);
  return path;
}

/** A port nobody is holding: listen on 0, take what was given, let go. */
function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer().listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });
}

function serveHealth(port: number): Promise<Server> {
  return new Promise((resolve) => {
    const s = createServer((req, res) => {
      res.writeHead(req.url === "/health" ? 200 : 404).end();
    }).listen(port, "127.0.0.1", () => resolve(s));
  });
}

async function answers(port: number): Promise<boolean> {
  try {
    return (await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(500) })).ok;
  } catch {
    return false;
  }
}

const logPath = async () => join(await mkdtemp(join(tmpdir(), "bench-hrlog-")), "headroom.log");

describe("findHeadroom", () => {
  it("finds nothing when the override is dead and PATH has none", async () => {
    // A BENCH_HEADROOM_BIN pointing at a file that is not there is a
    // misconfiguration, not a fallback trigger - the answer is absent.
    const empty = await mkdtemp(join(tmpdir(), "bench-path-"));
    expect(findHeadroom({
      BENCH_HEADROOM_BIN: join(empty, "headroom"),
      PATH: empty,
    })).toBeNull();
  });

  it("finds the binary on PATH", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bench-path-"));
    const bin = join(dir, "headroom");
    await writeFile(bin, "#!/bin/sh\n");
    await chmod(bin, 0o755);

    expect(findHeadroom({ PATH: dir })).toBe(bin);
  });
});

describe("HeadroomProxy", () => {
  it("starts the proxy, reports up, and kills it on stop", async () => {
    const port = await freePort();
    const proxy = new HeadroomProxy({
      bin: await makeBin(FAKE_HEADROOM),
      port,
      logPath: await logPath(),
    });

    await proxy.start();
    expect(proxy.state).toBe("up");
    expect(proxy.url()).toBe(`http://127.0.0.1:${port}`);

    proxy.stop();
    // The port going quiet is the assertion - the process being "killed"
    // is an internal detail; that nothing answers is the fact.
    await new Promise((r) => setTimeout(r, 300));
    expect(await answers(port)).toBe(false);
  });

  it("reuses a proxy already on the port instead of spawning its own", async () => {
    // One the developer runs themselves: borrowed, never killed - stopping
    // the daemon must not take down a service it did not start.
    const port = await freePort();
    const existing = await serveHealth(port);

    const marker = join(await mkdtemp(join(tmpdir(), "bench-marker-")), "spawned");
    const bin = await makeBin(`#!/usr/bin/env node\nrequire("node:fs").writeFileSync(${JSON.stringify(marker)}, "x");\n`);

    const proxy = new HeadroomProxy({ bin, port, logPath: await logPath() });
    await proxy.start();

    expect(proxy.state).toBe("up");
    expect(proxy.url()).toBe(`http://127.0.0.1:${port}`);
    await expect(access(marker)).rejects.toThrow();

    proxy.stop();
    expect(await answers(port)).toBe(true);
    existing.close();
  });

  it("reports a proxy that will not start, with its last words", async () => {
    const proxy = new HeadroomProxy({
      bin: await makeBin(DYING_HEADROOM),
      port: await freePort(),
      logPath: await logPath(),
    });

    await proxy.start();
    expect(proxy.state).toBe("failed");
    expect(proxy.url()).toBeNull();
    expect(proxy.reason).toContain("boom");
  });

  it("retries a start that failed, rather than replaying the failure", async () => {
    // The settings toggle calls start() again on a "failed" proxy - that is
    // the "I fixed it, try again" path, and a cached failure would make the
    // switch a no-op.
    const dir = await mkdtemp(join(tmpdir(), "bench-retry-"));
    const counter = join(dir, "attempts");
    // Dies the first time it is spawned, serves /health the second.
    const bin = await makeBin(`#!/usr/bin/env node
const fs = require("node:fs");
const n = Number(fs.existsSync(${JSON.stringify(counter)}) ? fs.readFileSync(${JSON.stringify(counter)}, "utf8") : "0") + 1;
fs.writeFileSync(${JSON.stringify(counter)}, String(n));
if (n < 2) { process.stderr.write("not yet\\n"); process.exit(1); }
const port = Number(process.argv[process.argv.indexOf("--port") + 1]);
require("node:http").createServer((req, res) => {
  res.writeHead(req.url === "/health" ? 200 : 404).end();
}).listen(port, "127.0.0.1");
`);

    const proxy = new HeadroomProxy({ bin, port: await freePort(), logPath: await logPath() });

    await proxy.start();
    expect(proxy.state).toBe("failed");

    await proxy.start();
    expect(proxy.state).toBe("up");
    expect(proxy.url()).not.toBeNull();
    proxy.stop();
  });

  it("keeps a slow-starting proxy starting rather than calling it failed", async () => {
    // Real headroom spends tens of seconds importing transformers before it
    // binds. The deadline is how long start() waits, not how long the proxy
    // gets - so past it the state is "starting", not "failed", and the
    // background poll still resolves it to up.
    const bin = await makeBin(`#!/usr/bin/env node
const port = Number(process.argv[process.argv.indexOf("--port") + 1]);
setTimeout(() => {
  require("node:http").createServer((req, res) => {
    res.writeHead(req.url === "/health" ? 200 : 404).end();
  }).listen(port, "127.0.0.1");
}, 600);
`);

    const port = await freePort();
    const proxy = new HeadroomProxy({ bin, port, logPath: await logPath(), startupTimeoutMs: 200 });

    await proxy.start();
    expect(proxy.state).toBe("starting");
    expect(proxy.url()).toBeNull();
    expect(proxy.reason).toBeNull();

    await new Promise((r) => setTimeout(r, 1000));
    expect(proxy.state).toBe("up");
    expect(proxy.url()).toBe(`http://127.0.0.1:${port}`);

    proxy.stop();
    await new Promise((r) => setTimeout(r, 300));
    expect(await answers(port)).toBe(false);
  });

  it("is absent, not failed, when there is no binary", async () => {
    const proxy = new HeadroomProxy({ bin: null, port: 8787, logPath: await logPath() });

    await proxy.start();
    expect(proxy.state).toBe("absent");
    expect(proxy.url()).toBeNull();
    expect(proxy.installed).toBe(false);
  });
});
