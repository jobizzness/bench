#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { isRole, ROLES } from "../shared/roles.js";
import { slugify } from "../shared/slug.js";
import { inheritedModel } from "../shared/auto-routers.js";

/**
 * The bench, from inside it.
 *
 * A specialist that has been asked to spec something and hand it to an
 * implementer needs a way to open a tab. It has a shell, so it could always
 * have curled the daemon - but it would have had to invent the URL, and
 * inventing an API is exactly what an agent should not be doing.
 *
 * A command rather than a documented request, for one reason above the
 * others: the token never reaches a command line. `curl "...?token=$(cat
 * ~/.bench/token)"` puts the secret in `ps` output for every process on the
 * machine to read. This reads it itself.
 *
 *   bench ls
 *   bench new <label>
 *   bench tell <label|id> <text...>
 *
 * There is no --project. A specialist works on one codebase and staffs it
 * with specialists on the same one; a tab somewhere else is the developer's
 * call, made in the cockpit.
 */

const HOME = process.env.BENCH_HOME ?? join(homedir(), ".bench");
const PORT = process.env.BENCH_COCKPIT_PORT ?? "7420";
const BASE = process.env.BENCH_URL ?? `http://127.0.0.1:${PORT}`;

function token(): string {
  const fromEnv = process.env.BENCH_TOKEN?.trim();
  if (fromEnv) return fromEnv;
  try {
    return readFileSync(join(HOME, "token"), "utf8").trim();
  } catch {
    fail(`no cockpit token. Looked in ${join(HOME, "token")} and $BENCH_TOKEN.`);
  }
}

function fail(message: string): never {
  process.stderr.write(`bench: ${message}\n`);
  process.exit(1);
}

async function call(path: string, init?: RequestInit): Promise<any> {
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      ...init,
      headers: { "x-bench-token": token(), "content-type": "application/json", ...(init?.headers ?? {}) },
    });
  } catch {
    fail(`no daemon answering at ${BASE}. Is Bench running?`);
  }

  if (res.status === 401) fail("the cockpit refused this token.");
  const body = await res.json().catch(() => ({}));
  if (!res.ok) fail(body.error ?? `${path} returned ${res.status}`);
  return body;
}

interface Row { id: string; label: string; project: string; status: string; detail: string }

const rows = async (): Promise<Row[]> => (await call("/api/roster")).rows ?? [];

/** The project this specialist is working on, which is the only one it staffs. */
function ownProject(all: Row[]): string {
  const id = process.env.BENCH_SESSION_ID;
  const mine = id ? all.find((r) => r.id === id) : undefined;
  if (mine) return mine.project;
  return process.env.BENCH_PROJECT
    ?? fail("cannot tell which project this is. Run this from inside a specialist.");
}

/** Labels repeat across projects, so a name only resolves within one. */
function resolve(all: Row[], project: string, name: string): Row {
  const here = all.filter((r) => r.project === project);
  // Labels are what a person writes now, so matching one from a command line
  // cannot be exact: `bench tell cash-pickup` should find "Cash pickup".
  const found = here.find((r) => r.id === name)
    ?? here.find((r) => r.label === name)
    ?? here.find((r) => slugify(r.label) === slugify(name));
  if (found) return found;

  const known = here.map((r) => r.label).join(", ") || "nobody";
  return fail(`no specialist called "${name}" on this project. Here: ${known}.`);
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);

  if (command === "ls") {
    const all = await rows();
    const project = ownProject(all);
    for (const row of all.filter((r) => r.project === project)) {
      const self = row.id === process.env.BENCH_SESSION_ID ? " (you)" : "";
      process.stdout.write(`${row.label}${self}\t${row.status}\t${row.detail}\n`);
    }
    return;
  }

  if (command === "new") {
    // `bench new implementer --as implementer` is the common shape, but the
    // label names the work as often as the kind, so they are separate.
    const as = args.indexOf("--as");
    const role = as === -1 ? undefined : args[as + 1];
    const label = args.filter((a, i) => i !== as && i !== as + 1)[0];
    if (!label) fail(`usage: bench new <label> [--as ${ROLES.join("|")}]`);
    if (as !== -1 && !isRole(role)) fail(`bench: no such role "${role ?? ""}". One of: ${ROLES.join(", ")}`);

    const all = await rows();
    const project = ownProject(all);
    const { id } = await call("/api/sessions", {
      method: "POST",
      // No model unless this specialist is itself on an auto router: the
      // daemon otherwise fills it from the role, which is what knows that a
      // researcher should not be opened on Opus. Auto mode is not a model
      // choice, so it is the one thing that follows into the tab it opens.
      body: JSON.stringify({ label, project, role, model: inheritedModel(process.env.BENCH_SELF_MODEL) }),
    });

    // It opens empty on purpose: what it is for is the first thing you tell
    // it, which is `bench tell`.
    process.stdout.write(`${id}\n`);
    process.stderr.write(
      `bench: opened "${label}". It is waiting - tell it what to do:\n`
      + `  bench tell ${label} "..."\n`,
    );
    return;
  }

  if (command === "tell") {
    const [name, ...rest] = args;
    const text = rest.join(" ").trim();
    if (!name || text === "") fail('usage: bench tell <label> "<what to do>"');

    const all = await rows();
    const target = resolve(all, ownProject(all), name);
    if (target.id === process.env.BENCH_SESSION_ID) fail("that is you.");

    await call(`/api/sessions/${target.id}/message`, {
      method: "POST",
      body: JSON.stringify({ text }),
    });
    process.stderr.write(`bench: told ${target.label}.\n`);
    return;
  }

  process.stderr.write(
    "bench — the roster, from inside it\n\n"
    + "  bench ls                      who is on this project\n"
    + "  bench new <label> [--as <role>]  open a tab, waiting to be told what to do\n"
    + '  bench tell <label> "<text>"   give one its next turn\n',
  );
  process.exit(command ? 1 : 0);
}

await main();
