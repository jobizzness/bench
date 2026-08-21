import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import type { BenchConfig } from "./config.js";
import { findReport } from "./reports.js";
import { readThread } from "./thread.js";
import type { RosterRow } from "../shared/types.js";

export interface SessionRegistryLike {
  list(): RosterRow[];
  get(id: string): { reportsDir: string; threadPath: string; alive: boolean } | null;
  answer(id: string, text: string): void;
  message(id: string, text: string): void;
  stop(id: string): void;
  create(input: { project: string; label: string; task: string; model: string }): Promise<string>;
  on(event: "roster", listener: () => void): unknown;
}

const CLIENT_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "client");

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

export function createServer(opts: { config: BenchConfig; registry: SessionRegistryLike }) {
  const { config, registry } = opts;

  const server = createHttpServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const path = url.pathname;

    // The shell bootstraps without a token; everything with data behind it
    // requires one, so nothing else on the machine can drive the agents.
    if (path === "/" || path === "/app.js" || path === "/styles.css") {
      const file = path === "/" ? "index.html" : path.slice(1);
      const type = file.endsWith(".js") ? "text/javascript"
        : file.endsWith(".css") ? "text/css" : "text/html";
      try {
        const body = await readFile(join(CLIENT_DIR, file), "utf8");
        res.writeHead(200, { "content-type": `${type}; charset=utf-8` });
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

    if (path === "/api/sessions" && req.method === "POST") {
      const body = await readBody(req);
      if (!body.project || !body.label || !body.task) {
        json(res, 400, { error: "project, label and task are required" });
        return;
      }
      const id = await registry.create({
        project: String(body.project),
        label: String(body.label),
        task: String(body.task),
        model: String(body.model ?? "opus"),
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

    const reportHtml = path.match(/^\/r\/([^/]+)\/([^/]+)\/report\.html$/);
    if (reportHtml && req.method === "GET") {
      const seq = Number(reportHtml[2]);
      // The sequence is the only client-supplied part of the path, so it
      // must be a plain positive integer or the request is refused.
      if (!Number.isInteger(seq) || seq < 1) { res.writeHead(400).end("bad sequence"); return; }

      const session = registry.get(reportHtml[1]);
      if (!session) { res.writeHead(404).end("no such session"); return; }

      const report = await findReport(session.reportsDir, seq);
      if (!report) { res.writeHead(404).end("no such report"); return; }

      const body = await readFile(report.htmlPath, "utf8");
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "content-security-policy": REPORT_CSP,
      });
      res.end(body);
      return;
    }

    const thread = path.match(/^\/api\/sessions\/([^/]+)\/thread$/);
    if (thread && req.method === "GET") {
      const session = registry.get(thread[1]);
      if (!session) { json(res, 404, { error: "no such session" }); return; }
      json(res, 200, { entries: await readThread(session.threadPath) });
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
      // message would strand it forever.
      if (!session.alive) { json(res, 409, { error: "session is not running" }); return; }

      registry.message(message[1], text);
      json(res, 200, { ok: true });
      return;
    }

    const answer = path.match(/^\/api\/sessions\/([^/]+)\/answer$/);
    if (answer && req.method === "POST") {
      if (!registry.get(answer[1])) { json(res, 404, { error: "no such session" }); return; }
      const body = await readBody(req);
      registry.answer(answer[1], formatAnswer(body.optionId, body.text));
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
  });

  const wss = new WebSocketServer({ server, path: "/events" });
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

  return server;
}
