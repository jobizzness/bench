import { describe, it, expect, afterEach } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createServer, type Server } from "node:http";
import { join } from "node:path";

const exec = promisify(execFile);

/** A stand-in for the daemon: enough of `/api/roster` and `/api/sessions`
 * for `bench new` to resolve its own project and open a tab. Remembers the
 * body of the last `/api/sessions` POST so a test can inspect what model
 * `bench new` decided to forward. */
/** `closeResponse` lets a test make the fake `/close` endpoint answer the way
 * the real daemon would for a dirty worktree (409 + counts) instead of the
 * default clean-close 200. */
async function fakeDaemon(opts: {
  closeStatus?: number;
  closeBody?: any;
} = {}): Promise<{ url: string; lastBody: () => any; closed: () => string[]; close: () => Promise<void> }> {
  let lastBody: any;
  const closedIds: string[] = [];
  const server: Server = createServer((req, res) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      if (req.url === "/api/roster") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ rows: [
          { id: "sess-parent", label: "parent", project: "proj-1", status: "idle", detail: "", createdBy: null },
          { id: "sess-child", label: "child", project: "proj-1", status: "idle", detail: "", createdBy: "sess-parent" },
          { id: "sess-other", label: "other", project: "proj-1", status: "idle", detail: "", createdBy: null },
        ] }));
        return;
      }
      if (req.url?.endsWith("/message") && req.method === "POST") {
        lastBody = JSON.parse(data);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      if (req.url === "/api/sessions" && req.method === "POST") {
        lastBody = JSON.parse(data);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ id: "sess-child" }));
        return;
      }
      const closeMatch = req.url?.match(/^\/api\/sessions\/([^/]+)\/close$/);
      if (closeMatch && req.method === "POST") {
        closedIds.push(closeMatch[1]);
        res.writeHead(opts.closeStatus ?? 200, { "content-type": "application/json" });
        res.end(JSON.stringify(opts.closeBody ?? { ok: true }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    lastBody: () => lastBody,
    closed: () => closedIds,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function runBench(env: Record<string, string | undefined>, args: string[]) {
  return exec("npx", ["tsx", join(process.cwd(), "src/cli/bench.ts"), ...args], {
    env: { ...process.env, ...env },
  });
}

async function runBenchNew(env: Record<string, string | undefined>, args: string[]) {
  return runBench(env, ["new", ...args]);
}

describe("bench new", () => {
  let daemon: Awaited<ReturnType<typeof fakeDaemon>>;

  afterEach(async () => {
    await daemon?.close();
  });

  it("forwards the parent's model when the parent is on an auto router", async () => {
    daemon = await fakeDaemon();
    await runBenchNew(
      { BENCH_URL: daemon.url, BENCH_TOKEN: "tok", BENCH_SESSION_ID: "sess-parent", BENCH_SELF_MODEL: "openrouter/auto" },
      ["implementer", "--as", "implementer"],
    );

    expect(daemon.lastBody().model).toBe("openrouter/auto");
  });

  it("sends nothing when the parent is pinned to a model, so the role decides", async () => {
    daemon = await fakeDaemon();
    await runBenchNew(
      { BENCH_URL: daemon.url, BENCH_TOKEN: "tok", BENCH_SESSION_ID: "sess-parent", BENCH_SELF_MODEL: "opus" },
      ["implementer", "--as", "implementer"],
    );

    expect(daemon.lastBody().model).toBeUndefined();
  });

  it("sends nothing when the parent never said what it is", async () => {
    daemon = await fakeDaemon();
    await runBenchNew(
      { BENCH_URL: daemon.url, BENCH_TOKEN: "tok", BENCH_SESSION_ID: "sess-parent", BENCH_SELF_MODEL: undefined },
      ["implementer", "--as", "implementer"],
    );

    expect(daemon.lastBody().model).toBeUndefined();
  });

  it("says which specialist is asking, so a tab it opens can be held for review", async () => {
    daemon = await fakeDaemon();
    await runBenchNew(
      { BENCH_URL: daemon.url, BENCH_TOKEN: "tok", BENCH_SESSION_ID: "sess-parent" },
      ["implementer", "--as", "implementer"],
    );

    expect(daemon.lastBody().createdBy).toBe("sess-parent");
  });
});

describe("bench tell", () => {
  let daemon: Awaited<ReturnType<typeof fakeDaemon>>;

  afterEach(async () => {
    await daemon?.close();
  });

  it("says which specialist is talking, so the message can be held for review", async () => {
    // Without this the daemon cannot tell an agent's `bench tell` from the
    // developer typing in the cockpit, and holds both.
    daemon = await fakeDaemon();
    await runBench(
      { BENCH_URL: daemon.url, BENCH_TOKEN: "tok", BENCH_SESSION_ID: "sess-parent" },
      ["tell", "child", "build the thing"],
    );

    expect(daemon.lastBody()).toMatchObject({ text: "build the thing", from: "sess-parent" });
  });
});

describe("bench close", () => {
  let daemon: Awaited<ReturnType<typeof fakeDaemon>>;

  afterEach(async () => {
    await daemon?.close();
  });

  it("closes a sub-agent it opened itself", async () => {
    daemon = await fakeDaemon();
    await runBench(
      { BENCH_URL: daemon.url, BENCH_TOKEN: "tok", BENCH_SESSION_ID: "sess-parent" },
      ["close", "child"],
    );

    expect(daemon.closed()).toEqual(["sess-child"]);
  });

  it("refuses a tab it did not open, even on the same project", async () => {
    daemon = await fakeDaemon();
    await expect(
      runBench({ BENCH_URL: daemon.url, BENCH_TOKEN: "tok", BENCH_SESSION_ID: "sess-parent" }, ["close", "other"]),
    ).rejects.toThrow(/not a tab you opened/);

    expect(daemon.closed()).toEqual([]);
  });

  it("refuses to close itself", async () => {
    daemon = await fakeDaemon();
    await expect(
      runBench({ BENCH_URL: daemon.url, BENCH_TOKEN: "tok", BENCH_SESSION_ID: "sess-parent" }, ["close", "parent"]),
    ).rejects.toThrow(/that is you/);

    expect(daemon.closed()).toEqual([]);
  });

  it("reports uncommitted work instead of forcing it away", async () => {
    daemon = await fakeDaemon({
      closeStatus: 409,
      closeBody: { error: "the worktree has work that exists nowhere else", changes: 3, unmergedCommits: 1 },
    });

    await expect(
      runBench({ BENCH_URL: daemon.url, BENCH_TOKEN: "tok", BENCH_SESSION_ID: "sess-parent" }, ["close", "child"]),
    ).rejects.toThrow(/3 uncommitted files and 1 commit on no other branch/);

    // Asked once, plainly - never retried with force from the CLI itself.
    expect(daemon.closed()).toEqual(["sess-child"]);
  });
});
