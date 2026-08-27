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
import { checkKey, type KeyCheck } from "./anthropic-key.js";
import type { TurnShape } from "../shared/cost.js";
import { isRole, type Role } from "../shared/roles.js";
import { checkKey as checkRouterKey, creditSource, type Listed } from "./openrouter.js";
import type { Credit } from "../shared/credit.js";
import type { Total } from "./ledger.js";
import { usageSource, type Usage } from "./usage.js";
import { RefIndex } from "./refs.js";
import { reviewBrief, reviewLabel } from "./review.js";
import { labelIsUsable } from "../shared/slug.js";
import { DEFAULT_MODEL } from "../shared/models.js";
import { cockpitOrigins, isLoopback } from "./urls.js";
import type { IntakeAnswer, RosterRow } from "../shared/types.js";

export interface SessionRegistryLike {
  list(): RosterRow[];
  getSettings(): Settings;
  saveSettings(input: unknown): Promise<Settings>;
  apiKeyState(): { present: boolean; hint: string; enabled: boolean; origin: string; searched: string[] };
  // No reader. The key goes to the daemon for the CLI's benefit, and a
  // server that cannot ask for it is a server that cannot serve it back.
  setApiKey(key: string): void;
  setApiKeyEnabled(on: boolean): void;
  clearApiKey(): void;
  // The OpenRouter key. Same rule as above: whether there is one goes out,
  // the key itself never does.
  routerKeyState(): { present: boolean; hint: string; origin: string; searched: string[] };
  setRouterKey(key: string): void;
  clearRouterKey(): void;
  /** Every model OpenRouter serves, for the picker. */
  catalogue(): Promise<Listed[]>;
  /** What a new specialist of this role should run on. */
  modelFor(role: Role): string;
  typicalTurn(): Promise<{ shape: TurnShape | null; turns: number }>;
  /** What has been spent, over the whole bench or one project. From the
   * ledger, so it counts specialists that have since been closed. */
  spend(project?: string | null): Promise<Total>;
  get(id: string): { reportsDir: string; threadPath: string; alive: boolean; revivable: boolean } | null;
  send(id: string, text: string, from?: string): void;
  close(id: string, opts?: { force?: boolean }): Promise<{ closed: boolean; changes: number; unmergedCommits: number }>;
  stop(id: string): void;
  clearContext(id: string): boolean;
  rename(id: string, label: string): boolean;
  setModel(id: string, model: string): Promise<void>;
  setRole(id: string, role: Role): Promise<void>;
  create(input: {
    project: string; label: string; model: string; role?: string; isolated?: boolean; createdBy?: string;
  }): Promise<string>;
  /** Release a tab's held first message. */
  dispatch(id: string): Promise<void>;
  /** Discard a tab's held first message. */
  decline(id: string): void;
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

/**
 * What a review Bench opens itself runs on.
 *
 * `reviewModel` predates roles having models of their own and is still the
 * more specific answer, so a developer who set one keeps it. Otherwise this
 * is simply the reviewer role, and the registry answers for it.
 */
function reviewerModel(registry: SessionRegistryLike): string {
  const settings = registry.getSettings();
  // Optional-chained: a settings file written before roles had models has
  // no table at all, and a review is not the place to find that out.
  const chosen = settings.roleModels?.reviewer;
  if (chosen === undefined && settings.reviewModel !== DEFAULT_MODEL) return settings.reviewModel;
  return registry.modelFor("reviewer");
}

export function createServer(opts: {
  config: BenchConfig;
  registry: SessionRegistryLike;
  /** Injected by the tests, which must not reach GitHub. */
  refs?: RefIndex;
  /** Where the built shell is. Injected by the tests, which run from source
   * and so have no bundle beside index.html. */
  clientDir?: string;
  /** Injected by the tests, which must not reach Anthropic. */
  checkKey?: (key: string) => Promise<KeyCheck>;
  /** The same, for OpenRouter. */
  checkRouterKey?: (key: string) => Promise<KeyCheck>;
  /** The same, for the OpenRouter credit meter. */
  credit?: () => Promise<Credit>;
  /** Where the usage panel's numbers come from. Injected by the tests, and
   * by index.ts with the key the registry is holding - the server itself is
   * deliberately unable to read that key. */
  usage?: () => Promise<Usage>;
}) {
  const { config, registry } = opts;
  const index = opts.refs ?? new RefIndex();
  const clientDir = opts.clientDir ?? CLIENT_DIR;
  const verify = opts.checkKey ?? checkKey;
  const verifyRouter = opts.checkRouterKey ?? checkRouterKey;
  const spent = opts.usage ?? usageSource({ benchKey: () => null });
  const routerSpent = opts.credit ?? creditSource({ key: () => null });

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

    /**
     * The developer's own Anthropic key. Held by the daemon for as long as it
     * runs and never written down, so these three routes are the whole of its
     * life: what there is, one to give, one to take away.
     */
    if (path === "/api/anthropic-key" && req.method === "GET") {
      json(res, 200, { ...registry.apiKeyState(), verified: true });
      return;
    }

    if (path === "/api/anthropic-key" && req.method === "POST") {
      const key = String((await readBody(req))?.key ?? "").trim();
      if (key === "") {
        json(res, 400, { error: "no key was sent" });
        return;
      }

      const verdict = await verify(key);
      if (verdict === "refused") {
        // Said now rather than discovered later. The CLI retries a rejected
        // key ten times with a doubling delay, so a typo kept here does not
        // look like a typo - it looks like a specialist that hangs.
        json(res, 400, { error: "The API turned that key away. Check it and try again." });
        return;
      }

      registry.setApiKey(key);
      // "unreachable" is not "wrong": an offline machine should still be able
      // to hold a key, as long as it is told the key is unproven.
      json(res, 200, { ...registry.apiKeyState(), verified: verdict === "ok" });
      return;
    }

    /**
     * The key, parked or in use.
     *
     * Its own route rather than a field on the save, because the key does
     * not go up with it: switching a held key off must not require the
     * developer to have it to hand.
     */
    if (path === "/api/anthropic-key/enabled" && req.method === "POST") {
      const enabled = (await readBody(req))?.enabled;
      if (typeof enabled !== "boolean") {
        json(res, 400, { error: "say true or false" });
        return;
      }

      registry.setApiKeyEnabled(enabled);
      // Verified stands: this is the same key the API already vouched for,
      // and parking it proves nothing new either way.
      json(res, 200, { ...registry.apiKeyState(), verified: true });
      return;
    }

    /**
     * What the credential behind this bench has spent.
     *
     * Nothing here is secret in the way the key is - it is percentages of
     * the developer's own windows - but it is theirs, so it goes out behind
     * the same token as everything else.
     */
    if (path === "/api/usage" && req.method === "GET") {
      json(res, 200, await spent());
      return;
    }

    if (path === "/api/anthropic-key" && req.method === "DELETE") {
      registry.clearApiKey();
      json(res, 200, { ...registry.apiKeyState(), verified: true });
      return;
    }

    /**
     * The developer's OpenRouter key, and what it can reach.
     *
     * Same life as the Anthropic key above - held while the daemon runs,
     * never written down - and the same three routes, so the cockpit treats
     * both the same way.
     */
    if (path === "/api/openrouter/key" && req.method === "GET") {
      json(res, 200, { ...registry.routerKeyState(), verified: true });
      return;
    }

    if (path === "/api/openrouter/key" && req.method === "POST") {
      const key = String((await readBody(req))?.key ?? "").trim();
      if (key === "") {
        json(res, 400, { error: "no key was sent" });
        return;
      }

      const verdict = await verifyRouter(key);
      if (verdict === "refused") {
        // Said now rather than discovered later. The CLI retries a rejected
        // key with a doubling delay, so a typo kept here does not look like a
        // typo - it looks like a specialist that hangs.
        json(res, 400, { error: "OpenRouter turned that key away. Check it and try again." });
        return;
      }

      registry.setRouterKey(key);
      // "unreachable" is not "wrong": an offline machine should still be able
      // to hold a key, as long as it is told the key is unproven.
      json(res, 200, { ...registry.routerKeyState(), verified: verdict === "ok" });
      return;
    }

    if (path === "/api/openrouter/key" && req.method === "DELETE") {
      registry.clearRouterKey();
      json(res, 200, { ...registry.routerKeyState(), verified: true });
      return;
    }

    /**
     * Every model OpenRouter serves.
     *
     * Read from OpenRouter rather than kept in a list here: a hand-maintained
     * list is one that goes stale invisibly, which is exactly what happened
     * to the one this replaced. Behind the token like everything else - it is
     * public information, but the cockpit asking for it is not a reason to
     * open a route that needs nothing.
     */
    /**
     * What the OpenRouter key has spent, for the meter beside the model name.
     *
     * A specialist on an OpenRouter model never touches the Anthropic
     * subscription, so the panel that reports that subscription is answering
     * about an account this turn will not be billed to. This is the account
     * it will.
     */
    if (path === "/api/openrouter/usage" && req.method === "GET") {
      json(res, 200, await routerSpent());
      return;
    }

    /**
     * The turn every model is priced against.
     *
     * Its own route rather than a field on the model list, because the two
     * change on completely different clocks: the catalogue is fetched once
     * and kept for the life of the daemon, and this moves every time any
     * specialist finishes a turn.
     */
    if (path === "/api/turn-shape" && req.method === "GET") {
      json(res, 200, await registry.typicalTurn());
      return;
    }

    /**
     * What this bench has spent, for good.
     *
     * Not derived from the roster, which is exactly the point: a roster only
     * knows about specialists that still exist, and closing one is the
     * ordinary end of a piece of work. Every total drawn from rows was a
     * total of the survivors.
     *
     * The two kinds of money stay apart, and the part of the figure that is
     * an estimate rather than a settled charge is reported alongside it -
     * a proxied turn priced from the catalogue measured 1.46x under against
     * the same requests billed by OpenRouter, so a total that hid which was
     * which would be a total nobody could act on.
     */
    if (path === "/api/spend" && req.method === "GET") {
      const project = url.searchParams.get("project");
      json(res, 200, await registry.spend(project));
      return;
    }

    if (path === "/api/openrouter/models" && req.method === "GET") {
      try {
        json(res, 200, { models: await registry.catalogue() });
      } catch (error) {
        // The picker still opens on Anthropic's four. Saying why beats an
        // empty list that looks like OpenRouter has nothing.
        json(res, 502, { error: error instanceof Error ? error.message : String(error) });
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
      try {
        const id = await registry.create({
          project: String(body.project),
          label: String(body.label),
          // Empty rather than Opus when the caller says nothing: the registry
          // fills it from the role, which is what knows whether this is a
          // researcher that should cost a fifth of a cent.
          model: body.model === undefined ? "" : String(body.model),
          role: typeof body.role === "string" ? body.role : undefined,
          // Absent means isolated. A caller that has not heard of the toggle
          // gets the safer of the two.
          isolated: body.isolated !== false,
          // Present only when another specialist's `bench new` made the
          // request - the CLI sends its own session id, the cockpit sends
          // nothing. What that decides is in registry.send().
          ...(typeof body.createdBy === "string" ? { createdBy: body.createdBy } : {}),
        });
        json(res, 200, { id });
      } catch (error) {
        // Caught here rather than left to the wrapper, which answers 500 with
        // a sentence that says nothing. The reasons a creation is refused are
        // things the developer can act on - no key for that provider, no way
        // to run the proxy, a proxy that would not start - and the dialog
        // they are still looking at is where those belong.
        process.stderr.write(`bench: could not create a specialist: ${String(error)}\n`);
        json(res, 400, { error: error instanceof Error ? error.message : String(error) });
      }
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
      // The skills ask for a fragment; the frame supplies the page it sits in,
      // drawn in whichever theme the cockpit that asked for it is on.
      res.end(artifactPage(body, url.searchParams.get("theme") ?? undefined));
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

      // Who is talking. `bench tell` sends its own session id; the cockpit's
      // composer sends nothing, and that difference is the whole of what
      // decides whether the message is held for the developer to read - see
      // registry.send(). Without it, the developer's own first message to a
      // spawned tab came back at them as something to dispatch.
      const from = typeof body.from === "string" && body.from !== "" ? body.from : undefined;

      registry.send(message[1], text, from);
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
        // The developer's standing answer to "who reviews", since nothing
        // asks them at the moment a reviewer is opened. An explicitly chosen
        // review model still wins; otherwise this is the reviewer role, and
        // the registry answers for it.
        model: body.model === undefined ? reviewerModel(registry) : String(body.model),
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

    /**
     * What this specialist runs on, changed after it was made.
     *
     * Refused here rather than on the next prompt when the new model needs a
     * provider the bench has no key for: the modal the developer is looking
     * at is where that belongs, and a prompt that dies two minutes later is
     * the failure this whole path exists to avoid.
     */
    const remodel = path.match(/^\/api\/sessions\/([^/]+)\/model$/);
    if (remodel && req.method === "POST") {
      if (!registry.get(remodel[1])) { json(res, 404, { error: "no such session" }); return; }
      const model = String((await readBody(req))?.model ?? "");
      try {
        await registry.setModel(remodel[1], model);
        json(res, 200, { model });
      } catch (error) {
        process.stderr.write(`bench: could not change the model: ${String(error)}\n`);
        json(res, 400, { error: error instanceof Error ? error.message : String(error) });
      }
      return;
    }

    /**
     * Releasing a tab another specialist spun up: the message it was told,
     * finally reaching the process.
     */
    const dispatch = path.match(/^\/api\/sessions\/([^/]+)\/dispatch$/);
    if (dispatch && req.method === "POST") {
      if (!registry.get(dispatch[1])) { json(res, 404, { error: "no such session" }); return; }
      try {
        await registry.dispatch(dispatch[1]);
        json(res, 200, { ok: true });
      } catch (error) {
        json(res, 400, { error: error instanceof Error ? error.message : String(error) });
      }
      return;
    }

    /** Discarding a held message. The tab stays, empty, as if it were never told. */
    const decline = path.match(/^\/api\/sessions\/([^/]+)\/decline$/);
    if (decline && req.method === "POST") {
      if (!registry.get(decline[1])) { json(res, 404, { error: "no such session" }); return; }
      registry.decline(decline[1]);
      json(res, 200, { ok: true });
      return;
    }

    /**
     * What kind of agent this is.
     *
     * Same shape as the model route above, because it is the same kind of
     * change: recorded now, in force on the next prompt, because the role
     * reaches the process as a system prompt and that is fixed at spawn.
     */
    const reroute = path.match(/^\/api\/sessions\/([^/]+)\/role$/);
    if (reroute && req.method === "POST") {
      if (!registry.get(reroute[1])) { json(res, 404, { error: "no such session" }); return; }
      const asked = (await readBody(req))?.role;
      if (!isRole(asked)) { json(res, 400, { error: "not a role this bench has" }); return; }
      try {
        await registry.setRole(reroute[1], asked);
        // The model may have moved with the role, so it is said back.
        json(res, 200, { role: asked, model: registry.list().find((r) => r.id === reroute[1])?.model });
      } catch (error) {
        process.stderr.write(`bench: could not change the role: ${String(error)}\n`);
        json(res, 400, { error: error instanceof Error ? error.message : String(error) });
      }
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

    const clear = path.match(/^\/api\/sessions\/([^/]+)\/clear$/);
    if (clear && req.method === "POST") {
      if (!registry.get(clear[1])) { json(res, 404, { error: "no such session" }); return; }
      registry.clearContext(clear[1]);
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
