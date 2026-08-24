import { createServer as createHttpServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import type { BenchConfig } from "./config.js";
import { findReport } from "./reports.js";
import { readPlan } from "./plan.js";
import { benchManifest } from "./manifest.js";
import { corsHeaders, isPreflight } from "./cors.js";
import { artifactPage } from "./artifact-page.js";
import { shareMessage } from "./share.js";
import { readThread } from "./thread.js";
import { listProjects } from "./projects.js";
import { houseRules, type Settings } from "./settings.js";
import { RefIndex } from "./refs.js";
import { reviewBrief, reviewLabel } from "./review.js";
import { labelIsUsable } from "../shared/slug.js";
import { cockpitOrigins, isLoopback } from "./urls.js";
import type { IntakeAnswer, RosterRow } from "../shared/types.js";

export interface SessionRegistryLike {
  list(): RosterRow[];
  getSettings(): Settings;
  saveSettings(input: unknown): Promise<Settings>;
  get(id: string): { reportsDir: string; threadPath: string; alive: boolean; revivable: boolean } | null;
  send(id: string, text: string): void;
  close(id: string, opts?: { force?: boolean }): Promise<{ closed: boolean; changes: number; unmergedCommits: number }>;
  stop(id: string): void;
  rename(id: string, label: string): boolean;
  create(input: {
    project: string; label: string; model: string; role?: string; isolated?: boolean;
  }): Promise<string>;
  on(event: "roster", listener: () => void): unknown;
}

const CLIENT_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "client");

/**
 * What the shell is allowed to fetch before it has proved anything.
 *
 * Named one file at a time rather than resolved from the path: this is the
 * one route that turns a URL into a filename, and a table cannot be talked
 * into ".." by anybody. The manifest is deliberately not here - it carries
 * the token, so it lives behind the token, below.
 */
const STATIC: Record<string, string> = {
  "/app.js": "text/javascript; charset=utf-8",
  "/styles.css": "text/css; charset=utf-8",
  "/sw.js": "text/javascript; charset=utf-8",
  "/favicon.svg": "image/svg+xml; charset=utf-8",
  "/icon.svg": "image/svg+xml; charset=utf-8",
  "/icons/icon-192.png": "image/png",
  "/icons/icon-512.png": "image/png",
  "/icons/apple-touch-icon.png": "image/png",
};

/** Reports are untrusted generated HTML: no network, no scripts from elsewhere. */
const REPORT_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:";

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(payload) });
  res.end(payload);
}

async function readBody(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return {};
  }
}

/** Turns the developer's choice into the message the agent receives. */
export function formatAnswer(optionId: string | undefined, text: string | undefined): string {
  const parts: string[] = [];
  if (optionId) parts.push(`[bench] decision: chose "${optionId}"`);
  if (text && text.trim() !== "") parts.push(text.trim());
  return parts.join("\n") || "[bench] decision: acknowledged";
}

function line(answer: IntakeAnswer): string {
  const chosen = answer.labels.join(", ");
  const said = answer.text?.trim() ?? "";
  // A question can be answered entirely off the menu, in which case the
  // words are the answer rather than a note against one.
  if (chosen === "") return `- ${answer.ask} → ${said === "" ? "—" : `"${said}"`}`;
  return `- ${answer.ask} → ${chosen}${said === "" ? "" : `  — "${said}"`}`;
}

/**
 * An intake comes back as two lists, because the difference matters to the
 * agent: an answer the developer actually chose is evidence, and a default
 * they never looked at is still only the agent's own guess. Collapsing both
 * into "chose x" is what makes an agent over-trust its own assumptions.
 */
export function formatIntake(answers: IntakeAnswer[], text?: string): string {
  const chosen = answers.filter((a) => !a.defaulted);
  const assumed = answers.filter((a) => a.defaulted);

  const parts = ["[bench] intake answers"];
  if (chosen.length) parts.push(["", "Decided by your developer:", ...chosen.map(line)].join("\n"));
  if (assumed.length) {
    parts.push([
      "",
      "Left to your defaults — they were not reviewed, so treat them as your own assumptions:",
      ...assumed.map(line),
    ].join("\n"));
  }
  if (text && text.trim() !== "") parts.push(["", text.trim()].join("\n"));
  return parts.join("\n");
}

/** Rejects anything that is not a well-formed intake answer from the client. */
function readIntakeAnswers(value: unknown): IntakeAnswer[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;

  const answers: IntakeAnswer[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object") return null;
    const a = raw as Record<string, unknown>;
    if (typeof a.questionId !== "string" || typeof a.ask !== "string") return null;
    if (!Array.isArray(a.labels) || a.labels.some((l) => typeof l !== "string")) return null;
    answers.push({
      questionId: a.questionId,
      ask: a.ask,
      labels: a.labels as string[],
      text: typeof a.text === "string" ? a.text : undefined,
      defaulted: a.defaulted === true,
    });
  }
  return answers;
}

/** The http server, plus the one thing shutting down needs from it. */
export interface BenchServer extends HttpServer {
  /** Drop every connection, so `close()` can actually finish. */
  closeSockets(): void;
}

export function createServer(opts: {
  config: BenchConfig;
  registry: SessionRegistryLike;
  /** Injected by the tests, which must not reach GitHub. */
  refs?: RefIndex;
  /** Where the built shell is. Injected by the tests, which run from source
   * and so have no bundle beside index.html. */
  clientDir?: string;
}) {
  const { config, registry } = opts;
  const index = opts.refs ?? new RefIndex();
  const clientDir = opts.clientDir ?? CLIENT_DIR;

  /**
   * A throw inside an async request handler is not caught by anything: node
   * does not await the promise it returns, so it becomes an unhandled
   * rejection and the process exits. One bad route therefore took down every
   * specialist on the bench - which is what stopping a turn did, by way of a
   * later message reaching a session whose process had gone.
   *
   * A request that fails should fail. The daemon supervising six agents
   * should not.
   */
  const server = createHttpServer((req, res) => {
    void handle(req, res).catch((error) => {
      process.stderr.write(`bench: ${req.method} ${req.url} failed: ${String(error)}\n`);
      if (!res.headersSent) json(res, 500, { error: "the daemon failed to handle that" });
      else res.end();
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const path = url.pathname;

    // Set before anything answers, so every route carries them - including
    // the ones that refuse. A 401 a browser cannot read is a cockpit that
    // cannot tell a wrong token from an unreachable machine.
    const origin = req.headers.origin;
    for (const [name, value] of Object.entries(corsHeaders(origin))) res.setHeader(name, value);

    // The browser asking whether it may, which it does before any request
    // carrying a token. There is nothing to authorise yet and nothing to say.
    if (isPreflight(req.method, origin)) {
      res.writeHead(204).end();
      return;
    }

    // The shell bootstraps without a token; everything with data behind it
    // requires one, so nothing else on the machine can drive the agents.
    // A session has a URL, so the shell answers there as well as at the root.
    // The client reads the id back out of the path; the daemon does not need
    // to know it, and never turns it into a filesystem path.
    const isShell = path === "/" || /^\/s\/[A-Za-z0-9-]+\/?$/.test(path);
    if (isShell || path in STATIC) {
      const file = isShell ? "index.html" : path.slice(1);
      try {
        const body = await readFile(join(clientDir, file));
        res.writeHead(200, {
          "content-type": isShell ? "text/html; charset=utf-8" : STATIC[path],
          // Revalidate rather than assume. The shell is rebuilt while the
          // daemon runs, and a heuristically cached app.js is a cockpit a
          // build behind the daemon it is talking to.
          "cache-control": "no-cache",
        });
        res.end(body);
      } catch {
        res.writeHead(404).end("not found");
      }
      return;
    }

    const token = req.headers["x-bench-token"] ?? url.searchParams.get("token");
    if (token !== config.token) {
      json(res, 401, { error: "unauthorized" });
      return;
    }

    // Behind the token, and built from it: an installed cockpit launches at
    // its own start_url with nobody to paste a link, so the token has to be
    // in the manifest - which means the manifest cannot be a static file.
    if (path === "/manifest.webmanifest") {
      res.writeHead(200, {
        "content-type": "application/manifest+json; charset=utf-8",
        // Nothing that carries a token gets to sit in a disk cache.
        "cache-control": "no-store",
      });
      res.end(JSON.stringify(benchManifest(config.token)));
      return;
    }

    // The rules travel with what a specialist is actually told, so the page
    // can show that back rather than describing it.
    if (path === "/api/settings" && req.method === "GET") {
      const settings = registry.getSettings();
      json(res, 200, { settings, framing: houseRules(settings) });
      return;
    }

    if (path === "/api/settings" && req.method === "POST") {
      try {
        const settings = await registry.saveSettings(await readBody(req));
        json(res, 200, { settings, framing: houseRules(settings) });
      } catch {
        // Either a field over its cap, or a body that is not a whole set of
        // settings - and half a set would erase the half it left out.
        json(res, 400, { error: "settings must arrive whole, and short enough to send every turn" });
      }
      return;
    }

    // Where else this same daemon answers. Without the token: the client
    // asking already holds one, and a list of addresses is not a secret while
    // the key that opens them is.
    if (path === "/api/addresses" && req.method === "GET") {
      json(res, 200, {
        origins: cockpitOrigins({ host: config.host, port: config.port }),
        loopbackOnly: isLoopback(config.host),
      });
      return;
    }

    if (path === "/api/projects" && req.method === "GET") {
      json(res, 200, { projects: await listProjects(config.projectsRoot) });
      return;
    }

    if (path === "/api/sessions" && req.method === "POST") {
      const body = await readBody(req);
      if (!body.project || !body.label) {
        json(res, 400, { error: "project and label are required" });
        return;
      }
      // Said here rather than left to fail at the worktree, where it surfaces
      // as a provisioning error with a git message under it.
      if (!labelIsUsable(String(body.label))) {
        json(res, 400, { error: "that label is empty or too long to name anything" });
        return;
      }
      const id = await registry.create({
        project: String(body.project),
        label: String(body.label),
        model: String(body.model ?? "opus"),
        role: typeof body.role === "string" ? body.role : undefined,
        // Absent means isolated. A caller that has not heard of the toggle
        // gets the safer of the two.
        isolated: body.isolated !== false,
      });
      json(res, 200, { id });
      return;
    }

    if (path === "/api/roster" && req.method === "GET") {
      json(res, 200, { rows: registry.list() });
      return;
    }

    const reportApi = path.match(/^\/api\/sessions\/([^/]+)\/report\/(\d+)$/);
    if (reportApi && req.method === "GET") {
      const session = registry.get(reportApi[1]);
      if (!session) { json(res, 404, { error: "no such session" }); return; }

      const report = await findReport(session.reportsDir, Number(reportApi[2]));
      if (!report) { json(res, 404, { error: "no such report" }); return; }

      json(res, 200, { seq: report.seq, decision: report.decision, malformed: report.malformed });
      return;
    }

    const reportHtml = path.match(/^\/r\/([^/]+)\/([^/]+)\/(report|reply)\.html$/);
    if (reportHtml && req.method === "GET") {
      const seq = Number(reportHtml[2]);
      const artifact = reportHtml[3];
      // The sequence is the only client-supplied part of the path, so it
      // must be a plain positive integer or the request is refused.
      if (!Number.isInteger(seq) || seq < 1) { res.writeHead(400).end("bad sequence"); return; }

      const session = registry.get(reportHtml[1]);
      if (!session) { res.writeHead(404).end("no such session"); return; }

      // A reply artifact stands alone - it has no decision.json, so it is
      // read by path rather than through findReport.
      const htmlPath = artifact === "reply"
        ? join(session.reportsDir, String(seq), "reply.html")
        : (await findReport(session.reportsDir, seq))?.htmlPath ?? null;
      if (!htmlPath) { res.writeHead(404).end("no such report"); return; }

      let body: string;
      try {
        body = await readFile(htmlPath, "utf8");
      } catch {
        res.writeHead(404).end("no such artifact");
        return;
      }
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "content-security-policy": REPORT_CSP,
      });
      // The skills ask for a fragment; the frame supplies the page it sits in.
      res.end(artifactPage(body));
      return;
    }

    const thread = path.match(/^\/api\/sessions\/([^/]+)\/thread$/);
    if (thread && req.method === "GET") {
      const session = registry.get(thread[1]);
      if (!session) { json(res, 404, { error: "no such session" }); return; }
      json(res, 200, { entries: await readThread(session.threadPath) });
      return;
    }

    // What the numbers in a thread are about. Answered per session because
    // #12 belongs to the repository the specialist is working in.
    const refs = path.match(/^\/api\/sessions\/([^/]+)\/refs$/);
    if (refs && req.method === "GET") {
      const project = registry.list().find((r) => r.id === refs[1])?.project;
      if (!project) { json(res, 404, { error: "no such session" }); return; }

      const numbers = (url.searchParams.get("n") ?? "")
        .split(",")
        .map((n) => Number(n.trim()))
        .filter((n) => Number.isInteger(n) && n > 0)
        .slice(0, 40);

      json(res, 200, { refs: numbers.length === 0 ? [] : await index.lookup(project, numbers) });
      return;
    }

    // What has been happening on the project's repository. Per session, like
    // the references, because it is that specialist's project being asked
    // about - and because the daemon never takes a path from a URL.
    const github = path.match(/^\/api\/sessions\/([^/]+)\/github$/);
    if (github && req.method === "GET") {
      const project = registry.list().find((r) => r.id === github[1])?.project;
      if (!project) { json(res, 404, { error: "no such session" }); return; }
      json(res, 200, await index.recent(project));
      return;
    }

    const message = path.match(/^\/api\/sessions\/([^/]+)\/message$/);
    if (message && req.method === "POST") {
      const session = registry.get(message[1]);
      if (!session) { json(res, 404, { error: "no such session" }); return; }

      const body = await readBody(req);
      const text = String(body.text ?? "").trim();
      if (text === "") { json(res, 400, { error: "text is required" }); return; }

      // A dead process cannot be queued into, and silently accepting the
      // message would strand it forever. A specialist restored from disk has
      // no process yet either, but prompting it is what brings it back.
      if (!session.alive && !session.revivable) {
        json(res, 409, { error: "session is not running" });
        return;
      }

      registry.send(message[1], text);
      json(res, 200, { ok: true });
      return;
    }

    // A second pair of eyes on one specialist's work, opened from its report.
    // A whole session rather than a subagent: its own worktree, its own
    // conversation, and a report of its own to answer - a reviewer that
    // reports upward into the thing it is reviewing is not independent of it.
    const review = path.match(/^\/api\/sessions\/([^/]+)\/review$/);
    if (review && req.method === "POST") {
      const subject = registry.list().find((r) => r.id === review[1]);
      if (!subject) { json(res, 404, { error: "no such session" }); return; }
      if (subject.branch === "") {
        json(res, 409, { error: "it has no branch to review yet" });
        return;
      }

      const body = await readBody(req);
      const seq = Number(body.seq);
      const reportPath = Number.isInteger(seq) && seq > 0
        ? join(subject.project, ".bench", "reports", subject.id, String(seq), "report.html")
        : null;

      const id = await registry.create({
        project: subject.project,
        label: reviewLabel(subject.label),
        model: String(body.model ?? "opus"),
        role: "reviewer",
        isolated: true,
      });
      registry.send(id, reviewBrief({
        label: subject.label,
        branch: subject.branch,
        reportPath,
      }));

      json(res, 200, { id });
      return;
    }

    // What a specialist is called, changed from the header. The branch is
    // not renamed with it: see the note in the registry.
    const rename = path.match(/^\/api\/sessions\/([^/]+)\/label$/);
    if (rename && req.method === "POST") {
      const body = await readBody(req);
      const label = typeof body.label === "string" ? body.label : "";
      if (!labelIsUsable(label)) {
        json(res, 400, { error: "that label is empty or too long to name anything" });
        return;
      }
      if (!registry.rename(rename[1], label)) {
        json(res, 404, { error: "no such session" });
        return;
      }
      json(res, 200, { label: label.trim() });
      return;
    }

    const answer = path.match(/^\/api\/sessions\/([^/]+)\/answer$/);
    if (answer && req.method === "POST") {
      if (!registry.get(answer[1])) { json(res, 404, { error: "no such session" }); return; }
      const body = await readBody(req);

      // An intake answers many questions at once; the single-option shape is
      // still what a plain spec_approval or completion sends back.
      if (body.answers !== undefined) {
        const answers = readIntakeAnswers(body.answers);
        if (!answers) { json(res, 400, { error: "answers is malformed" }); return; }
        registry.send(answer[1], formatIntake(answers, body.text));
      } else {
        registry.send(answer[1], formatAnswer(body.optionId, body.text));
      }
      json(res, 200, { ok: true });
      return;
    }

    const plan = path.match(/^\/api\/sessions\/([^/]+)\/plan$/);
    if (plan && req.method === "GET") {
      const session = registry.get(plan[1]);
      if (!session) { json(res, 404, { error: "no such session" }); return; }
      json(res, 200, { steps: await readPlan(session.reportsDir) });
      return;
    }

    const share = path.match(/^\/api\/sessions\/([^/]+)\/share$/);
    if (share && req.method === "POST") {
      const source = registry.get(share[1]);
      if (!source) { json(res, 404, { error: "no such session" }); return; }

      const body = await readBody(req);
      const seq = Number(body.seq);
      const to: string[] = Array.isArray(body.to) ? body.to.map(String) : [];
      const file = body.file === "reply.html" ? "reply.html" : "report.html";

      if (!Number.isInteger(seq) || seq < 1) { json(res, 400, { error: "seq is required" }); return; }
      if (to.length === 0) { json(res, 400, { error: "nobody to share with" }); return; }

      const row = registry.list().find((r) => r.id === share[1]);
      const report = await findReport(source.reportsDir, seq);
      const message = shareMessage({
        from: row?.label ?? "a specialist",
        title: report?.decision.title ?? `Report ${seq}`,
        path: join(source.reportsDir, String(seq), file),
        note: typeof body.note === "string" ? body.note : undefined,
      });

      // Within the project and nowhere else. A report is about one codebase,
      // and a specialist in another has no worktree it applies to. Enforced
      // here rather than only in the menu: a filter the client draws is not a
      // rule, it is a suggestion.
      const rows = registry.list();
      const sameProject = new Set(
        rows.filter((r) => r.project === row?.project).map((r) => r.id),
      );

      // A specialist that has gone is not a reason to fail the others.
      const sent = to.filter((id) =>
        id !== share[1] && sameProject.has(id) && registry.get(id) !== null);
      for (const id of sent) registry.send(id, message);

      json(res, 200, { sent: sent.length });
      return;
    }

    const close = path.match(/^\/api\/sessions\/([^/]+)\/close$/);
    if (close && req.method === "POST") {
      if (!registry.get(close[1])) { json(res, 404, { error: "no such session" }); return; }
      const body = await readBody(req);
      const result = await registry.close(close[1], { force: body.force === true });

      // Refusing is the point: say what would have been destroyed so the
      // developer can look before deciding to force it.
      if (!result.closed) {
        json(res, 409, {
          error: "the worktree has work that exists nowhere else",
          changes: result.changes,
          unmergedCommits: result.unmergedCommits,
        });
        return;
      }
      json(res, 200, { ok: true });
      return;
    }

    const stop = path.match(/^\/api\/sessions\/([^/]+)\/stop$/);
    if (stop && req.method === "POST") {
      if (!registry.get(stop[1])) { json(res, 404, { error: "no such session" }); return; }
      registry.stop(stop[1]);
      json(res, 200, { ok: true });
      return;
    }

    json(res, 404, { error: "not found" });
  }

  const wss = new WebSocketServer({ server, path: "/events" });

  /**
   * The cockpit holds its roster socket open for as long as the tab is, and
   * `server.close()` waits for every connection to end before it calls back.
   * So Ctrl-C did nothing visible: the daemon stayed up holding the port,
   * the developer killed it, and the next one started beside a specialist
   * that was still running. Twice that ended with two daemons writing one
   * index.
   *
   * Stopping is not a negotiation. The sockets are told, then dropped.
   */
  (server as BenchServer).closeSockets = () => {
    for (const socket of wss.clients) {
      // A code the page reads as "gone, try again" rather than "refused",
      // so an open cockpit reconnects when the daemon comes back.
      socket.close(1001, "bench is stopping");
      socket.terminate();
    }
    wss.close();
    // Keep-alive connections with nothing in flight are the same problem
    // with a shorter fuse.
    server.closeAllConnections();
  };
  wss.on("connection", (socket, req) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.searchParams.get("token") !== config.token) { socket.close(1008, "unauthorized"); return; }

    const send = () => socket.send(JSON.stringify({ type: "roster", rows: registry.list() }));
    send();
    registry.on("roster", send);
    socket.on("close", () => {
      (registry as unknown as { off(e: string, l: () => void): void }).off?.("roster", send);
    });
  });

  return server as BenchServer;
}
