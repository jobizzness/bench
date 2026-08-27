import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { EventEmitter } from "node:events";
import { cp, mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createServer, formatIntake } from "../src/daemon/server.js";
import { keyHint, type KeyCheck } from "../src/daemon/anthropic-key.js";
import type { Usage } from "../src/daemon/usage.js";
import type { Credit } from "../src/shared/credit.js";
import type { IntakeAnswer, RosterRow } from "../src/shared/types.js";

const TOKEN = "test-token-abc";

class StubRegistry extends EventEmitter {
  rows: RosterRow[] = [
    { id: "s1", label: "auth", project: "/var/www/demo", branch: "bench/auth-abcd1234", status: "awaiting_decision", detail: "waiting", latestReportSeq: 1, startedAt: null, tokens: 0 },
  ];
  sent: Array<{ id: string; text: string }> = [];
  created: any[] = [];
  reportsDir = "";

  list() { return this.rows; }
  /** The turn the picker prices models against. Empty until a bench has run
   * some, which is what a test bench has done. */
  turnShape: { shape: unknown; turns: number } = { shape: null, turns: 0 };
  async typicalTurn() { return this.turnShape; }
  /** What the real registry answers from the role table. The stub only has to
   * be asked, so it says the one thing these tests care about. */
  modelFor(role: string) { return this.settings.roleModels[role] ?? "qwen/qwen3-coder-flash"; }
  settings = { codingStyle: "", workflowRules: "", reviewModel: "sonnet", roleModels: {} as Record<string, string> };
  getSettings() { return this.settings; }
  key: string | null = null;
  keyOn = true;
  apiKeyState() {
    return this.key === null
      ? { present: false, hint: "", enabled: this.keyOn }
      : { present: true, hint: keyHint(this.key), enabled: this.keyOn };
  }
  getApiKey() { return this.keyOn ? this.key : null; }
  setApiKey(key: string) { this.key = key; this.keyOn = true; }
  setApiKeyEnabled(on: boolean) { this.keyOn = on; }
  clearApiKey() { this.key = null; this.keyOn = true; }
  threadPathValue = "";
  aliveValue = true;
  revivableValue = false;

  get(id: string) {
    return id === "s1"
      ? { reportsDir: this.reportsDir, threadPath: this.threadPathValue, alive: this.aliveValue, revivable: this.revivableValue }
      : null;
  }
  send(id: string, text: string, from?: string) { this.sent.push({ id, text, from }); }
  closed: Array<{ id: string; force: boolean }> = [];
  closeResult: any = { closed: true, changes: 0, unmergedCommits: 0 };
  async close(id: string, opts: any = {}) {
    this.closed.push({ id, force: opts.force === true });
    return this.closeResult;
  }
  stop() {}
  cleared: string[] = [];
  clearContext(id: string) {
    if (id !== "s1") return false;
    this.cleared.push(id);
    return true;
  }
  renamed: Array<{ id: string; label: string }> = [];
  rename(id: string, label: string) {
    if (id !== "s1") return false;
    this.renamed.push({ id, label });
    return true;
  }
  async create(input: any) { this.created.push(input); return "s2"; }
  remodelled: Array<{ id: string; model: string }> = [];
  remodelError: string | null = null;
  async setModel(id: string, model: string) {
    if (this.remodelError !== null) throw new Error(this.remodelError);
    this.remodelled.push({ id, model });
  }
  dispatched: string[] = [];
  dispatchError: string | null = null;
  async dispatch(id: string) {
    if (this.dispatchError !== null) throw new Error(this.dispatchError);
    this.dispatched.push(id);
  }
  declined: string[] = [];
  decline(id: string) { this.declined.push(id); }

  /** The OpenRouter key. Held the same way the Anthropic one is, and reported
   * the same way: whether there is one, never which one. */
  routerKey: string | null = null;
  routerKeyState() {
    return this.routerKey === null
      ? { present: false, hint: "" }
      : { present: true, hint: keyHint(this.routerKey) };
  }
  setRouterKey(key: string) { this.routerKey = key; }
  clearRouterKey() { this.routerKey = null; }
  catalogueError: string | null = null;
  models = [
    { id: "google/gemini-3.7-flash", name: "Google: Gemini 3.7 Flash", vendor: "google", contextLength: 1048576 },
  ];
  async catalogue() {
    if (this.catalogueError !== null) throw new Error(this.catalogueError);
    return this.models;
  }
}

let server: ReturnType<typeof createServer>;
let base: string;
let registry: StubRegistry;
let projectsRoot: string;
let clientDir: string;
/** What the API is pretending to say about a key. The tests must not reach
 * Anthropic any more than they reach GitHub. */
let verdict: KeyCheck = "ok";
/** The same, for OpenRouter. */
let routerVerdict: KeyCheck = "ok";
let usage: Usage = { available: false, reason: "none" };
/** The same, for the OpenRouter credit meter. */
let credit: Credit = { available: false, reason: "none" };

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

  // The real shell, plus the two files that only exist after a build. The
  // static route is worth testing against what it actually serves - a PNG
  // read as text is a PNG that no longer decodes - so this is a copy of
  // src/client rather than a set of stand-ins.
  clientDir = await mkdtemp(join(tmpdir(), "bench-client-"));
  await cp("src/client", clientDir, { recursive: true });
  await writeFile(join(clientDir, "app.js"), "/* built bundle */\n");
  await writeFile(join(clientDir, "sw.js"), "/* built worker */\n");

  server = createServer({
    config: { home: "/tmp/bench", port: 0, token: TOKEN, pluginDir: "/tmp/plugin", hookCommand: "node hook.js", projectsRoot },
    registry: registry as any,
    clientDir,
    checkKey: async () => verdict,
    checkRouterKey: async () => routerVerdict,
    usage: async () => usage,
    credit: async () => credit,
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

describe("a cockpit this daemon did not serve", () => {
  const from = "https://bench-cockpit.web.app";

  it("answers the browser's preflight, which is what carries no token", async () => {
    const res = await fetch(`${base}/api/roster`, {
      method: "OPTIONS",
      headers: {
        origin: from,
        "access-control-request-method": "GET",
        "access-control-request-headers": "x-bench-token",
      },
    });

    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe(from);
    expect(res.headers.get("access-control-allow-headers")).toContain("x-bench-token");
    // Chrome will not let a public page touch an address on your desk
    // without this, which is the whole arrangement here.
    expect(res.headers.get("access-control-allow-private-network")).toBe("true");
  });

  it("lets that origin read the answer once it presents a token", async () => {
    const res = await fetch(`${base}/api/roster`, { headers: { ...auth.headers, origin: from } });
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe(from);
    expect(res.headers.get("vary")).toContain("Origin");
  });

  it("lets it read the refusal too, which is how a wrong token is named", async () => {
    // A 401 the page cannot read looks exactly like a machine that is not
    // there, and the two are fixed differently.
    const res = await fetch(`${base}/api/roster`, { headers: { origin: from } });
    expect(res.status).toBe(401);
    expect(res.headers.get("access-control-allow-origin")).toBe(from);
  });

  it("says nothing about origins to a request that named none", async () => {
    const res = await fetch(`${base}/api/roster`, auth);
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("still refuses an unauthorised request from an allowed origin", async () => {
    // Allowing an origin to ask is not allowing it in.
    const res = await fetch(`${base}/api/sessions/s1/message`, {
      method: "POST",
      headers: { origin: from, "content-type": "application/json" },
      body: JSON.stringify({ text: "hello" }),
    });
    expect(res.status).toBe(401);
  });
});

describe("what an installed cockpit fetches", () => {
  it("keeps the manifest behind the token, since it contains one", async () => {
    // start_url carries the token. Served without auth, /manifest.webmanifest
    // would hand a shell on this machine to anyone on the network.
    const res = await fetch(`${base}/manifest.webmanifest`);
    expect(res.status).toBe(401);
  });

  it("serves a manifest that launches straight into this cockpit", async () => {
    const res = await fetch(`${base}/manifest.webmanifest?token=${TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/manifest+json");
    // Nothing carrying a token belongs in a disk cache.
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect((await res.json()).start_url).toBe(`/?token=${TOKEN}`);
  });

  it("serves the worker without a token, because it holds no secrets", async () => {
    const res = await fetch(`${base}/sw.js`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/javascript");
  });

  it("serves the icons whole, as PNG rather than as mangled text", async () => {
    const res = await fetch(`${base}/icons/icon-192.png`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");

    // Read as UTF-8 and re-encoded, a PNG loses bytes and no longer decodes.
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect([...bytes.slice(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
    expect(bytes.byteLength).toBeGreaterThan(1000);
  });

  it("asks the browser to check the shell rather than assume it", async () => {
    // The shell is rebuilt while the daemon runs, and a heuristically cached
    // app.js is a cockpit a build behind the daemon it talks to.
    const res = await fetch(`${base}/app.js`);
    expect(res.headers.get("cache-control")).toBe("no-cache");
  });

  it("still refuses a path it was not told to serve", async () => {
    for (const path of ["/../package.json", "/icons/../../package.json", "/config.js"]) {
      expect((await fetch(`${base}${path}`)).status).not.toBe(200);
    }
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

  it("forwards an intake as two lists, separating chosen from assumed", async () => {
    registry.sent.length = 0;
    const res = await fetch(`${base}/api/sessions/s1/answer`, {
      method: "POST",
      headers: { ...auth.headers, "content-type": "application/json" },
      body: JSON.stringify({
        answers: [
          { questionId: "expiry", ask: "How long?", labels: ["1 hour"], defaulted: false },
          { questionId: "rate", ask: "Rate limit?", labels: ["reuse"], defaulted: true },
        ],
        text: "keep the copy terse",
      }),
    });

    expect(res.status).toBe(200);
    const sent = registry.sent[0].text;
    expect(sent).toContain("Decided by your developer:");
    expect(sent).toContain("- How long? → 1 hour");
    expect(sent).toContain("not reviewed");
    expect(sent).toContain("- Rate limit? → reuse");
    expect(sent).toContain("keep the copy terse");
    // The whole point is that the agent can tell the two apart.
    expect(sent.indexOf("How long?")).toBeLessThan(sent.indexOf("Rate limit?"));
  });

  it("400s on a malformed answers array rather than sending nonsense", async () => {
    registry.sent.length = 0;
    const res = await fetch(`${base}/api/sessions/s1/answer`, {
      method: "POST",
      headers: { ...auth.headers, "content-type": "application/json" },
      body: JSON.stringify({ answers: [{ questionId: "expiry" }] }),
    });

    expect(res.status).toBe(400);
    expect(registry.sent).toHaveLength(0);
  });
});

describe("formatIntake", () => {
  const answer = (over: Partial<IntakeAnswer> = {}): IntakeAnswer =>
    ({ questionId: "q", ask: "Which?", labels: ["A"], defaulted: false, ...over });

  it("omits the developer's list when everything ran on defaults", () => {
    const out = formatIntake([answer({ defaulted: true })]);
    expect(out).not.toContain("Decided by your developer");
    expect(out).toContain("your defaults");
  });

  it("omits the defaults list when the developer answered everything", () => {
    const out = formatIntake([answer()]);
    expect(out).toContain("Decided by your developer");
    expect(out).not.toContain("your defaults");
  });

  it("joins a multi-select into one line", () => {
    expect(formatIntake([answer({ labels: ["Web", "Mobile"] })])).toContain("→ Web, Mobile");
  });

  it("treats free text as the answer when nothing was picked", () => {
    const out = formatIntake([answer({ labels: [], text: "neither — use the old flow" })]);
    expect(out).toContain('→ "neither — use the old flow"');
  });

  it("keeps free text alongside a pick", () => {
    const out = formatIntake([answer({ text: "but only for staff" })]);
    expect(out).toContain('→ A  — "but only for staff"');
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

  it("carries who is asking through to the registry", async () => {
    await fetch(`${base}/api/sessions`, {
      method: "POST",
      headers: { ...auth.headers, "content-type": "application/json" },
      body: JSON.stringify({ project: "/var/www/demo", label: "auth", createdBy: "sess-parent" }),
    });
    expect(registry.created.at(-1).createdBy).toBe("sess-parent");
  });

  it("says nothing was asking when the cockpit itself made the request", async () => {
    await fetch(`${base}/api/sessions`, {
      method: "POST",
      headers: { ...auth.headers, "content-type": "application/json" },
      body: JSON.stringify({ project: "/var/www/demo", label: "auth" }),
    });
    expect(registry.created.at(-1).createdBy).toBeUndefined();
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
    expect(registry.sent.at(-1)).toEqual({ id: "s1", text: "why zod?", from: undefined });
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
    expect(registry.sent.at(-1)).toEqual({ id: "s1", text: "carry on", from: undefined });
    registry.aliveValue = true;
    registry.revivableValue = false;
  });

  it("says who sent it, when a specialist did", async () => {
    // `bench tell` names itself; the cockpit's composer does not. What the
    // daemon does with the difference is hold the message or deliver it.
    const res = await fetch(`${base}/api/sessions/s1/message`, {
      method: "POST",
      headers: { ...auth.headers, "content-type": "application/json" },
      body: JSON.stringify({ text: "build the thing", from: "sess-parent" }),
    });

    expect(res.status).toBe(200);
    expect(registry.sent.at(-1)).toEqual({ id: "s1", text: "build the thing", from: "sess-parent" });
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

describe("POST /api/sessions/:id/clear", () => {
  it("clears the specialist's conversation", async () => {
    const res = await fetch(`${base}/api/sessions/s1/clear`, {
      method: "POST", headers: { ...auth.headers, "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(registry.cleared.at(-1)).toBe("s1");
  });

  it("404s for a session that does not exist", async () => {
    const before = registry.cleared.length;
    const res = await fetch(`${base}/api/sessions/nope/clear`, {
      method: "POST", headers: { ...auth.headers, "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(404);
    expect(registry.cleared.length).toBe(before);
  });
});

describe("a session URL", () => {
  it("serves the cockpit so a specialist can be bookmarked", async () => {
    const res = await fetch(`${base}/s/89c0812e-ff63-4918-a200-59c393d72fdd`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
  });

  it("serves it with a trailing slash too", async () => {
    expect((await fetch(`${base}/s/abc/`)).status).toBe(200);
  });

  it("does not turn a session path into a file path", async () => {
    // The id reaches the shell as text and is read back by the client. It
    // must never be able to name a file: anything that is not an id falls
    // through to the token check rather than being served.
    const res = await fetch(`${base}/s/..%2f..%2fpackage.json`);
    expect(res.status).not.toBe(200);
    expect(await res.text()).not.toContain("devDependencies");
  });

  it("still 404s an unknown path", async () => {
    expect((await fetch(`${base}/nope`, auth)).status).toBe(404);
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

describe("renaming a specialist", () => {
  it("takes a new name and hands it to the registry trimmed", async () => {
    const res = await fetch(`${base}/api/sessions/s1/label`, {
      method: "POST", ...auth, body: JSON.stringify({ label: "  session cookies on Safari  " }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ label: "session cookies on Safari" });
    expect(registry.renamed.at(-1)).toEqual({ id: "s1", label: "  session cookies on Safari  " });
  });

  it("refuses a name that is empty or too long to be one", async () => {
    const before = registry.renamed.length;
    for (const label of ["", "   ", "x".repeat(200)]) {
      const res = await fetch(`${base}/api/sessions/s1/label`, {
        method: "POST", ...auth, body: JSON.stringify({ label }),
      });
      expect(res.status).toBe(400);
    }
    expect(registry.renamed).toHaveLength(before);
  });

  it("refuses a specialist that is not on the bench", async () => {
    const res = await fetch(`${base}/api/sessions/nobody/label`, {
      method: "POST", ...auth, body: JSON.stringify({ label: "hello" }),
    });
    expect(res.status).toBe(404);
  });
});

describe("who reviews", () => {
  it("opens the reviewer on the model settings names", async () => {
    // Nothing asks at the moment a review starts - the button has no field
    // on it - so the standing answer is the only answer there is.
    const res = await fetch(`${base}/api/sessions/s1/review`, {
      method: "POST", ...auth, body: JSON.stringify({ seq: 1 }),
    });
    expect(res.status).toBe(200);

    const opened = registry.created.at(-1);
    expect(opened.model).toBe("sonnet");
    expect(opened.role).toBe("reviewer");
  });

  it("lets the request name one instead", async () => {
    await fetch(`${base}/api/sessions/s1/review`, {
      method: "POST", ...auth, body: JSON.stringify({ seq: 1, model: "haiku" }),
    });
    expect(registry.created.at(-1).model).toBe("haiku");
  });
});

describe("the developer's own API key", () => {
  const KEY = "sk-ant-api03-typed-into-the-cockpit-4f2a";

  const put = (body: unknown) =>
    fetch(`${base}/api/anthropic-key`, { method: "POST", ...auth, body: JSON.stringify(body) });

  beforeEach(() => { verdict = "ok"; registry.key = null; registry.keyOn = true; });

  it("says there is no key when none has been given", async () => {
    const res = await fetch(`${base}/api/anthropic-key`, auth);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ present: false, hint: "", enabled: true, verified: true });
  });

  it("keeps a key the API vouches for", async () => {
    const res = await put({ key: KEY });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ present: true, hint: "…4f2a", enabled: true, verified: true });
    expect(registry.getApiKey()).toBe(KEY);
  });

  it("never says the key back, only which one it is", async () => {
    // It goes to the daemon and does not come out. Anything that can read
    // the cockpit could otherwise read the key.
    registry.key = KEY;

    const body = await (await fetch(`${base}/api/anthropic-key`, auth)).text();

    expect(body).not.toContain(KEY);
    expect(body).toContain("…4f2a");
  });

  it("refuses a key the API turns away", async () => {
    // Refusing here is the whole point: the CLI retries a bad key ten times
    // before it gives up, so a typo kept now is a specialist that hangs.
    verdict = "refused";

    const res = await put({ key: "sk-ant-wrong" });

    expect(res.status).toBe(400);
    expect(registry.getApiKey()).toBeNull();
  });

  it("keeps a key it could not check, and admits it did not", async () => {
    verdict = "unreachable";

    const res = await put({ key: KEY });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ present: true, hint: "…4f2a", enabled: true, verified: false });
    expect(registry.getApiKey()).toBe(KEY);
  });

  it("refuses an empty key rather than storing one", async () => {
    const res = await put({ key: "   " });

    expect(res.status).toBe(400);
    expect(registry.getApiKey()).toBeNull();
  });

  it("forgets the key when asked to", async () => {
    registry.key = KEY;

    const res = await fetch(`${base}/api/anthropic-key`, { method: "DELETE", ...auth });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ present: false, hint: "", enabled: true, verified: true });
    expect(registry.getApiKey()).toBeNull();
  });

  it("takes no key at all from someone without the token", async () => {
    const res = await fetch(`${base}/api/anthropic-key`, { method: "POST", body: JSON.stringify({ key: KEY }) });

    expect(res.status).toBe(401);
    expect(registry.getApiKey()).toBeNull();
  });
});

describe("what has been spent", () => {
  const WINDOWS: Usage = {
    available: true,
    windows: [
      { key: "five_hour", label: "5-hour", percent: 41, resetsAt: "2026-08-25T14:20:00Z" },
      { key: "seven_day", label: "7-day", percent: 68, resetsAt: null },
    ],
  };

  it("serves every window it was given", async () => {
    usage = WINDOWS;

    const res = await fetch(`${base}/api/usage`, auth);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(WINDOWS);
  });

  it("says there is nothing to show rather than failing", async () => {
    // A bench with no oauth credential is the ordinary case, not an error.
    // The cockpit hides the icon on this answer; a 500 would light it red.
    usage = { available: false, reason: "none" };

    const res = await fetch(`${base}/api/usage`, auth);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ available: false, reason: "none" });
  });

  it("tells nobody without the token what has been spent", async () => {
    usage = WINDOWS;

    expect((await fetch(`${base}/api/usage`)).status).toBe(401);
  });
});

/**
 * The other account a specialist can be billed to.
 *
 * A specialist on an OpenRouter model never touches the Anthropic
 * subscription, so the panel that reports that subscription is answering
 * about the wrong account. This is the one it is actually spent from.
 */
describe("what an OpenRouter key has spent", () => {
  it("serves the spend and the ceiling", async () => {
    credit = { available: true, spent: 12.4, limit: 50 };

    const res = await fetch(`${base}/api/openrouter/usage`, auth);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ available: true, spent: 12.4, limit: 50 });
  });

  it("serves a key with no ceiling as having none", async () => {
    credit = { available: true, spent: 3, limit: null };

    expect(await (await fetch(`${base}/api/openrouter/usage`, auth)).json())
      .toEqual({ available: true, spent: 3, limit: null });
  });

  it("says there is nothing to show rather than failing", async () => {
    // A bench with no OpenRouter key is the ordinary case, not an error.
    credit = { available: false, reason: "none" };

    const res = await fetch(`${base}/api/openrouter/usage`, auth);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ available: false, reason: "none" });
  });

  it("tells nobody without the token what has been spent", async () => {
    credit = { available: true, spent: 12.4, limit: 50 };

    expect((await fetch(`${base}/api/openrouter/usage`)).status).toBe(401);
  });
});

describe("parking the key without throwing it away", () => {
  const KEY = "sk-ant-api03-typed-into-the-cockpit-4f2a";
  const set = (enabled: boolean) =>
    fetch(`${base}/api/anthropic-key/enabled`, { method: "POST", ...auth, body: JSON.stringify({ enabled }) });

  beforeEach(() => { registry.key = KEY; registry.keyOn = true; });

  it("stops handing the key out, and says so", async () => {
    const res = await set(false);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ present: true, hint: "…4f2a", enabled: false, verified: true });
    expect(registry.getApiKey()).toBeNull();
  });

  it("keeps the key itself, so it need not be typed again", async () => {
    await set(false);

    expect(registry.key).toBe(KEY);
  });

  it("hands it out again when switched back on", async () => {
    await set(false);

    await set(true);

    expect(registry.getApiKey()).toBe(KEY);
  });

  it("refuses anything that is not an answer to the question", async () => {
    const res = await fetch(`${base}/api/anthropic-key/enabled`, {
      method: "POST", ...auth, body: JSON.stringify({ enabled: "yes please" }),
    });

    expect(res.status).toBe(400);
    expect(registry.getApiKey()).toBe(KEY);
  });

  it("lets nobody without the token park the key", async () => {
    const res = await fetch(`${base}/api/anthropic-key/enabled`, {
      method: "POST", body: JSON.stringify({ enabled: false }),
    });

    expect(res.status).toBe(401);
    expect(registry.getApiKey()).toBe(KEY);
  });
});

/**
 * The developer's OpenRouter key.
 *
 * Same three routes and same rules as the Anthropic key: it goes up and never
 * comes back down, a refusal is caught before the key is kept, and an
 * unreachable service is not a reason to refuse one.
 */
describe("the OpenRouter key", () => {
  beforeEach(() => {
    registry.routerKey = null;
    registry.catalogueError = null;
    routerVerdict = "ok";
  });

  it("says whether there is one, and never what it is", async () => {
    registry.routerKey = "sk-or-v1-supersecret";
    const body = await (await fetch(`${base}/api/openrouter/key`, auth)).json();

    expect(body.present).toBe(true);
    expect(JSON.stringify(body)).not.toContain("supersecret");
  });

  it("keeps a key OpenRouter answered for", async () => {
    const res = await fetch(`${base}/api/openrouter/key`, {
      method: "POST", ...auth, body: JSON.stringify({ key: "sk-or-v1-good" }),
    });

    expect(res.status).toBe(200);
    expect((await res.json()).verified).toBe(true);
    expect(registry.routerKey).toBe("sk-or-v1-good");
  });

  it("refuses a key OpenRouter turned away, rather than keeping it", async () => {
    // Said now rather than discovered later: the CLI retries a rejected key
    // with a doubling delay, so a typo kept here looks like a hang.
    routerVerdict = "refused";
    const res = await fetch(`${base}/api/openrouter/key`, {
      method: "POST", ...auth, body: JSON.stringify({ key: "sk-or-v1-typo" }),
    });

    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("OpenRouter");
    expect(registry.routerKey).toBe(null);
  });

  it("keeps an unproven key when OpenRouter could not be reached", async () => {
    routerVerdict = "unreachable";
    const res = await fetch(`${base}/api/openrouter/key`, {
      method: "POST", ...auth, body: JSON.stringify({ key: "sk-or-v1-maybe" }),
    });

    expect(res.status).toBe(200);
    expect((await res.json()).verified).toBe(false);
    expect(registry.routerKey).toBe("sk-or-v1-maybe");
  });

  it("refuses an empty key", async () => {
    const res = await fetch(`${base}/api/openrouter/key`, {
      method: "POST", ...auth, body: JSON.stringify({ key: "   " }),
    });
    expect(res.status).toBe(400);
  });

  it("lets go of a key when asked", async () => {
    registry.routerKey = "sk-or-v1-old";
    const res = await fetch(`${base}/api/openrouter/key`, { method: "DELETE", ...auth });

    expect(res.status).toBe(200);
    expect(registry.routerKey).toBe(null);
  });

  it("lets nobody without the token set or read it", async () => {
    const read = await fetch(`${base}/api/openrouter/key`);
    const write = await fetch(`${base}/api/openrouter/key`, {
      method: "POST", body: JSON.stringify({ key: "k" }),
    });

    expect(read.status).toBe(401);
    expect(write.status).toBe(401);
    expect(registry.routerKey).toBe(null);
  });
});

describe("the model catalogue", () => {
  beforeEach(() => { registry.catalogueError = null; });

  it("serves what OpenRouter carries", async () => {
    const body = await (await fetch(`${base}/api/openrouter/models`, auth)).json();
    expect(body.models[0].id).toBe("google/gemini-3.7-flash");
    expect(body.models[0].contextLength).toBe(1048576);
  });

  it("says why rather than serving an empty list", async () => {
    // An empty picker looks like OpenRouter has nothing. Anthropic's four
    // still work, so this is a note, not a failure.
    registry.catalogueError = "OpenRouter answered 503 for its model list";
    const res = await fetch(`${base}/api/openrouter/models`, auth);

    expect(res.status).toBe(502);
    expect((await res.json()).error).toContain("503");
  });

  it("is behind the token like everything else", async () => {
    expect((await fetch(`${base}/api/openrouter/models`)).status).toBe(401);
  });
});

/**
 * A creation that cannot go ahead.
 *
 * The reasons are things the developer can act on - no key for that provider,
 * no way to run the proxy - so they have to survive the trip back rather than
 * arriving as a 500 that says nothing.
 */
describe("refusing to create a specialist", () => {
  it("says why, in the words the registry used", async () => {
    const registryThatRefuses = registry as any;
    const before = registryThatRefuses.create;
    registryThatRefuses.create = async () => {
      throw new Error("no OpenRouter key - add one in Settings to run a specialist on this model");
    };
    try {
      const res = await fetch(`${base}/api/sessions`, {
        method: "POST", ...auth,
        body: JSON.stringify({ project: "/var/www/demo", label: "gem", model: "google/gemini-3.7-flash" }),
      });

      expect(res.status).toBe(400);
      expect((await res.json()).error).toContain("no OpenRouter key");
    } finally {
      registryThatRefuses.create = before;
    }
  });
});


/**
 * Moving a specialist onto another model.
 *
 * The refusal matters more than the success: a model whose provider has no
 * key has to be turned away here, in the modal the developer is looking at,
 * rather than on the next prompt.
 */
describe("what a specialist runs on", () => {
  beforeEach(() => {
    registry.remodelled = [];
    registry.remodelError = null;
  });

  it("is changed on request", async () => {
    const res = await fetch(`${base}/api/sessions/s1/model`, {
      method: "POST", ...auth, body: JSON.stringify({ model: "google/gemini-3.7-flash" }),
    });

    expect(res.status).toBe(200);
    expect(registry.remodelled).toEqual([{ id: "s1", model: "google/gemini-3.7-flash" }]);
  });

  it("carries back the reason it could not be", async () => {
    registry.remodelError = "no OpenRouter key - add one in Settings";
    const res = await fetch(`${base}/api/sessions/s1/model`, {
      method: "POST", ...auth, body: JSON.stringify({ model: "google/gemini-3.7-flash" }),
    });

    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("no OpenRouter key - add one in Settings");
  });

  it("has never heard of a specialist that is not there", async () => {
    const res = await fetch(`${base}/api/sessions/nobody/model`, {
      method: "POST", ...auth, body: JSON.stringify({ model: "haiku" }),
    });
    expect(res.status).toBe(404);
  });

  it("lets nobody without the token move a specialist", async () => {
    const res = await fetch(`${base}/api/sessions/s1/model`, {
      method: "POST", body: JSON.stringify({ model: "haiku" }),
    });

    expect(res.status).toBe(401);
    expect(registry.remodelled).toEqual([]);
  });
});

describe("a tab held for the developer to dispatch or decline", () => {
  beforeEach(() => {
    registry.dispatched = [];
    registry.dispatchError = null;
    registry.declined = [];
  });

  it("dispatches on request", async () => {
    const res = await fetch(`${base}/api/sessions/s1/dispatch`, { method: "POST", ...auth });

    expect(res.status).toBe(200);
    expect(registry.dispatched).toEqual(["s1"]);
  });

  it("carries back the reason it could not be dispatched", async () => {
    registry.dispatchError = "nothing is waiting to be dispatched";
    const res = await fetch(`${base}/api/sessions/s1/dispatch`, { method: "POST", ...auth });

    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("nothing is waiting to be dispatched");
  });

  it("404s dispatching a specialist that is not there", async () => {
    const res = await fetch(`${base}/api/sessions/nobody/dispatch`, { method: "POST", ...auth });
    expect(res.status).toBe(404);
  });

  it("declines on request", async () => {
    const res = await fetch(`${base}/api/sessions/s1/decline`, { method: "POST", ...auth });

    expect(res.status).toBe(200);
    expect(registry.declined).toEqual(["s1"]);
  });

  it("404s declining a specialist that is not there", async () => {
    const res = await fetch(`${base}/api/sessions/nobody/decline`, { method: "POST", ...auth });
    expect(res.status).toBe(404);
  });

  it("lets nobody without the token dispatch or decline", async () => {
    const dispatchRes = await fetch(`${base}/api/sessions/s1/dispatch`, { method: "POST" });
    const declineRes = await fetch(`${base}/api/sessions/s1/decline`, { method: "POST" });

    expect(dispatchRes.status).toBe(401);
    expect(declineRes.status).toBe(401);
    expect(registry.dispatched).toEqual([]);
    expect(registry.declined).toEqual([]);
  });
});

describe("the turn every model is priced against", () => {
  it("is served from what the bench has actually run", async () => {
    registry.turnShape = {
      shape: { freshIn: 10, cacheWrite: 20, cacheRead: 30, out: 40 },
      turns: 7,
    };

    const res = await fetch(`${base}/api/turn-shape`, { headers: { "x-bench-token": TOKEN } });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      shape: { freshIn: 10, cacheWrite: 20, cacheRead: 30, out: 40 },
      turns: 7,
    });
  });

  it("says it has none rather than inventing one", async () => {
    registry.turnShape = { shape: null, turns: 0 };

    const res = await fetch(`${base}/api/turn-shape`, { headers: { "x-bench-token": TOKEN } });

    expect(await res.json()).toEqual({ shape: null, turns: 0 });
  });

  it("is behind the token, like everything else about this developer's work", async () => {
    const res = await fetch(`${base}/api/turn-shape`);

    expect(res.status).toBe(401);
  });
});
