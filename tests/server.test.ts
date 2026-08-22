import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createServer } from "../src/daemon/server.js";
import type { RosterRow } from "../src/shared/types.js";

const TOKEN = "test-token-abc";

class StubRegistry extends EventEmitter {
  rows: RosterRow[] = [
    { id: "s1", label: "auth", project: "/var/www/demo", status: "awaiting_decision", detail: "waiting", latestReportSeq: 1, startedAt: null, tokens: 0 },
  ];
  sent: Array<{ id: string; text: string }> = [];
  created: any[] = [];
  reportsDir = "";

  list() { return this.rows; }
  threadPathValue = "";
  aliveValue = true;
  revivableValue = false;

  get(id: string) {
    return id === "s1"
      ? { reportsDir: this.reportsDir, threadPath: this.threadPathValue, alive: this.aliveValue, revivable: this.revivableValue }
      : null;
  }
  send(id: string, text: string) { this.sent.push({ id, text }); }
  closed: Array<{ id: string; force: boolean }> = [];
  closeResult: any = { closed: true, changes: 0, unmergedCommits: 0 };
  async close(id: string, opts: any = {}) {
    this.closed.push({ id, force: opts.force === true });
    return this.closeResult;
  }
  stop() {}
  async create(input: any) { this.created.push(input); return "s2"; }
}

let server: ReturnType<typeof createServer>;
let base: string;
let registry: StubRegistry;
let projectsRoot: string;

beforeAll(async () => {
  registry = new StubRegistry();

  const reportsDir = await mkdtemp(join(tmpdir(), "bench-srv-"));
  await mkdir(join(reportsDir, "1"), { recursive: true });
  await writeFile(join(reportsDir, "1", "report.html"), "<h1>hello report</h1>");
  await writeFile(
    join(reportsDir, "1", "decision.json"),
    JSON.stringify({ kind: "completion", title: "T", summary: "S", options: [], allowFreeText: true }),
  );
  registry.reportsDir = reportsDir;
  registry.threadPathValue = join(reportsDir, "thread.jsonl");
  await writeFile(
    registry.threadPathValue,
    JSON.stringify({ at: new Date().toISOString(), kind: "user", body: "hello there" }) + "\n",
  );

  projectsRoot = await mkdtemp(join(tmpdir(), "bench-projroot-"));
  await mkdir(join(projectsRoot, "demo-repo", ".git"), { recursive: true });

  server = createServer({
    config: { home: "/tmp/bench", port: 0, token: TOKEN, pluginDir: "/tmp/plugin", hookCommand: "node hook.js", projectsRoot },
    registry: registry as any,
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => { server.close(); });

const auth = { headers: { "x-bench-token": TOKEN } };

describe("auth", () => {
  it("rejects a request with no token", async () => {
    const res = await fetch(`${base}/api/roster`);
    expect(res.status).toBe(401);
  });

  it("rejects a request with the wrong token", async () => {
    const res = await fetch(`${base}/api/roster`, { headers: { "x-bench-token": "nope" } });
    expect(res.status).toBe(401);
  });

  it("serves the UI shell without a token, since it has to bootstrap", async () => {
    const res = await fetch(`${base}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
  });
});

describe("GET /api/roster", () => {
  it("returns the roster rows", async () => {
    const res = await fetch(`${base}/api/roster`, auth);
    const body = await res.json();
    expect(body.rows[0].id).toBe("s1");
  });

  it("never leaks a worktree path to the client", async () => {
    const res = await fetch(`${base}/api/roster`, auth);
    const text = await res.text();
    expect(text).not.toContain(".claude/worktrees");
  });
});

describe("GET /api/sessions/:id/report/:seq", () => {
  it("returns the decision for a report", async () => {
    const res = await fetch(`${base}/api/sessions/s1/report/1`, auth);
    const body = await res.json();
    expect(body.decision.title).toBe("T");
    expect(body.malformed).toBe(false);
  });

  it("404s for a report that does not exist", async () => {
    const res = await fetch(`${base}/api/sessions/s1/report/9`, auth);
    expect(res.status).toBe(404);
  });
});

describe("GET /r/:id/:seq/report.html", () => {
  it("serves the report body", async () => {
    const res = await fetch(`${base}/r/s1/1/report.html`, auth);
    expect(await res.text()).toContain("hello report");
  });

  it("sends a restrictive content security policy", async () => {
    const res = await fetch(`${base}/r/s1/1/report.html`, auth);
    expect(res.headers.get("content-security-policy")).toContain("default-src");
  });

  it("refuses a path traversal attempt in the sequence", async () => {
    const res = await fetch(`${base}/r/s1/..%2f..%2fetc/report.html`, auth);
    expect(res.status).toBe(400);
  });
});

describe("POST /api/sessions/:id/answer", () => {
  it("forwards the answer to the registry", async () => {
    const res = await fetch(`${base}/api/sessions/s1/answer`, {
      method: "POST",
      headers: { ...auth.headers, "content-type": "application/json" },
      body: JSON.stringify({ optionId: "ship", text: "go" }),
    });

    expect(res.status).toBe(200);
    expect(registry.sent[0].id).toBe("s1");
    expect(registry.sent[0].text).toContain("ship");
    expect(registry.sent[0].text).toContain("go");
  });

  it("404s for an unknown session", async () => {
    const res = await fetch(`${base}/api/sessions/nope/answer`, {
      method: "POST",
      headers: { ...auth.headers, "content-type": "application/json" },
      body: JSON.stringify({ text: "hi" }),
    });
    expect(res.status).toBe(404);
  });
});

describe("POST /api/sessions", () => {
  it("creates a session and returns its id", async () => {
    const res = await fetch(`${base}/api/sessions`, {
      method: "POST",
      headers: { ...auth.headers, "content-type": "application/json" },
      body: JSON.stringify({ project: "/var/www/demo", label: "auth" }),
    });
    expect((await res.json()).id).toBe("s2");
    expect(registry.created[0].label).toBe("auth");
  });

  it("400s when required fields are missing", async () => {
    const res = await fetch(`${base}/api/sessions`, {
      method: "POST",
      headers: { ...auth.headers, "content-type": "application/json" },
      body: JSON.stringify({ project: "/var/www/demo" }),
    });
    expect(res.status).toBe(400);
  });
});

describe("GET /api/sessions/:id/thread", () => {
  it("returns the thread entries", async () => {
    const res = await fetch(`${base}/api/sessions/s1/thread`, auth);
    const body = await res.json();
    expect(body.entries[0].body).toBe("hello there");
    expect(body.entries[0].seq).toBe(1);
  });

  it("404s for an unknown session", async () => {
    const res = await fetch(`${base}/api/sessions/nope/thread`, auth);
    expect(res.status).toBe(404);
  });
});

describe("POST /api/sessions/:id/message", () => {
  it("forwards the message to the registry", async () => {
    const res = await fetch(`${base}/api/sessions/s1/message`, {
      method: "POST",
      headers: { ...auth.headers, "content-type": "application/json" },
      body: JSON.stringify({ text: "why zod?" }),
    });

    expect(res.status).toBe(200);
    expect(registry.sent.at(-1)).toEqual({ id: "s1", text: "why zod?" });
  });

  it("accepts a message for a cold specialist that can be revived", async () => {
    // Restored from disk after a restart: no process yet, but not dead.
    registry.aliveValue = false;
    registry.revivableValue = true;
    const res = await fetch(`${base}/api/sessions/s1/message`, {
      method: "POST",
      headers: { ...auth.headers, "content-type": "application/json" },
      body: JSON.stringify({ text: "carry on" }),
    });

    expect(res.status).toBe(200);
    expect(registry.sent.at(-1)).toEqual({ id: "s1", text: "carry on" });
    registry.aliveValue = true;
    registry.revivableValue = false;
  });

  it("400s on an empty message", async () => {
    const res = await fetch(`${base}/api/sessions/s1/message`, {
      method: "POST",
      headers: { ...auth.headers, "content-type": "application/json" },
      body: JSON.stringify({ text: "   " }),
    });
    expect(res.status).toBe(400);
  });

  it("409s when the session process is no longer alive", async () => {
    registry.aliveValue = false;
    const res = await fetch(`${base}/api/sessions/s1/message`, {
      method: "POST",
      headers: { ...auth.headers, "content-type": "application/json" },
      body: JSON.stringify({ text: "anyone there?" }),
    });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/not running/i);
    registry.aliveValue = true;
  });
});

describe("GET /api/sessions/:id/plan", () => {
  it("returns the specialist's checklist", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bench-planapi-"));
    await mkdir(join(dir, "1"), { recursive: true });
    await writeFile(join(dir, ".turn"), "1");
    await writeFile(join(dir, "1", "plan.json"), JSON.stringify({
      steps: [{ text: "Fix the guard", state: "doing" }],
    }));
    registry.reportsDir = dir;

    const res = await fetch(`${base}/api/sessions/s1/plan`, auth);
    expect(res.status).toBe(200);
    expect((await res.json()).steps).toEqual([{ text: "Fix the guard", state: "doing" }]);
  });

  it("returns null steps when there is no plan, not an empty list", async () => {
    // An empty checklist would read as "nothing left to do".
    registry.reportsDir = await mkdtemp(join(tmpdir(), "bench-planapi-"));

    const res = await fetch(`${base}/api/sessions/s1/plan`, auth);
    expect(res.status).toBe(200);
    expect((await res.json()).steps).toBeNull();
  });

  it("404s for a session that does not exist", async () => {
    const res = await fetch(`${base}/api/sessions/nope/plan`, auth);
    expect(res.status).toBe(404);
  });
});

describe("POST /api/sessions/:id/close", () => {
  it("closes a specialist", async () => {
    const res = await fetch(`${base}/api/sessions/s1/close`, {
      method: "POST", headers: { ...auth.headers, "content-type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(200);
    expect(registry.closed.at(-1)).toEqual({ id: "s1", force: false });
  });

  it("409s with what would be lost when the worktree is not clean", async () => {
    registry.closeResult = { closed: false, changes: 3, unmergedCommits: 2 };
    const res = await fetch(`${base}/api/sessions/s1/close`, {
      method: "POST", headers: { ...auth.headers, "content-type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.changes).toBe(3);
    expect(body.unmergedCommits).toBe(2);
    registry.closeResult = { closed: true, changes: 0, unmergedCommits: 0 };
  });

  it("passes force through", async () => {
    const res = await fetch(`${base}/api/sessions/s1/close`, {
      method: "POST", headers: { ...auth.headers, "content-type": "application/json" },
      body: JSON.stringify({ force: true }),
    });

    expect(res.status).toBe(200);
    expect(registry.closed.at(-1)).toEqual({ id: "s1", force: true });
  });

  it("404s for a session that does not exist", async () => {
    const res = await fetch(`${base}/api/sessions/nope/close`, {
      method: "POST", headers: { ...auth.headers, "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(404);
  });
});

describe("GET /api/projects", () => {
  it("lists git repos under the configured root", async () => {
    const res = await fetch(`${base}/api/projects`, auth);
    const body = await res.json();
    expect(body.projects.map((p: { name: string }) => p.name)).toEqual(["demo-repo"]);
  });

  it("requires a token", async () => {
    const res = await fetch(`${base}/api/projects`);
    expect(res.status).toBe(401);
  });
});
