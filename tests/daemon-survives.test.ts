import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { AddressInfo } from "node:net";
import { createServer } from "../src/daemon/server.js";
import { RefIndex } from "../src/daemon/refs.js";
import type { RosterRow } from "../src/shared/types.js";

/**
 * Stopping a turn took the whole bench down with it.
 *
 * The chain: stop killed the process, the registry kept pointing at the dead
 * session, the next message reached it and threw "session not started" - and
 * a throw inside an async request handler is not caught by anything, so node
 * ended the process and every other specialist went with it.
 *
 * These cover the outer half. One route failing must never be the end of the
 * daemon supervising six agents.
 */
const row: RosterRow = {
  id: "s1", label: "auth", project: "/p", status: "working", detail: "Bash",
  latestReportSeq: null, answeredReportSeq: null, startedAt: null, tokens: 0,
  activity: [],
};

class ThrowingRegistry {
  list() { return [row]; }
  getSettings() { return { framing: "", review: "" } as any; }
  async saveSettings() { return { framing: "", review: "" } as any; }
  get() { return { reportsDir: "/r", threadPath: "/t", alive: false, revivable: true }; }
  send(): void {
    // Exactly what a stopped specialist used to do.
    throw new Error("session not started");
  }
  async close() { return { closed: true, changes: 0, unmergedCommits: 0 }; }
  stop() {}
  async create() { return "s2"; }
  on() { return this; }
}

let base: string;
let server: ReturnType<typeof createServer>;
const auth = { headers: { "x-bench-token": "t" } };

beforeAll(async () => {
  server = createServer({
    config: {
      home: "/tmp", host: "127.0.0.1", port: 0, token: "t",
      pluginDir: "/p", hookCommand: "true", projectsRoot: "/tmp",
    } as any,
    registry: new ThrowingRegistry() as any,
    refs: new RefIndex(),
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => { server.close(); });

describe("a route that throws", () => {
  it("answers 500 rather than ending the process", async () => {
    const res = await fetch(`${base}/api/sessions/s1/message`, {
      method: "POST",
      headers: { ...auth.headers, "content-type": "application/json" },
      body: JSON.stringify({ text: "are you there?" }),
    });

    expect(res.status).toBe(500);
  });

  it("leaves the daemon answering afterwards", async () => {
    // The point of the whole thing: the other specialists are still supervised.
    await fetch(`${base}/api/sessions/s1/message`, {
      method: "POST",
      headers: { ...auth.headers, "content-type": "application/json" },
      body: JSON.stringify({ text: "again" }),
    }).catch(() => null);

    const res = await fetch(`${base}/api/roster`, auth);
    expect(res.status).toBe(200);
    expect((await res.json()).rows).toHaveLength(1);
  });
});
