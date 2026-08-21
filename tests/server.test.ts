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
    { id: "s1", label: "auth", project: "/var/www/demo", status: "awaiting_decision", detail: "waiting", latestReportSeq: 1 },
  ];
  answers: Array<{ id: string; text: string }> = [];
  created: any[] = [];
  reportsDir = "";

  list() { return this.rows; }
  get(id: string) { return id === "s1" ? { reportsDir: this.reportsDir } : null; }
  answer(id: string, text: string) { this.answers.push({ id, text }); }
  stop() {}
  async create(input: any) { this.created.push(input); return "s2"; }
}

let server: ReturnType<typeof createServer>;
let base: string;
let registry: StubRegistry;

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

  server = createServer({
    config: { home: "/tmp/bench", port: 0, token: TOKEN, pluginDir: "/tmp/plugin", hookCommand: "node hook.js" },
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
    expect(registry.answers[0].id).toBe("s1");
    expect(registry.answers[0].text).toContain("ship");
    expect(registry.answers[0].text).toContain("go");
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
      body: JSON.stringify({ project: "/var/www/demo", label: "auth", task: "add reset" }),
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
