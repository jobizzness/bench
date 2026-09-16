import { spawn } from "node:child_process";

/** One entry in the Devin model picker — a family, not an effort variant. */
export interface DevinFamily {
  id: string;
  label: string;
}

const TIMEOUT_MS = 10_000;

/**
 * Devin's own account of what it can run, grouped by family - `devin models
 * list --format json`, organized the same way the CLI's human-readable
 * output is ("List available models, organized by model family").
 *
 * Read fresh from the machine rather than hand-maintained: `shared/models.ts`
 * already explains why a hardcoded list goes stale silently, and Devin's
 * roughly 48 families / 385 variants is not this bench's catalogue to keep
 * in sync - it is Devin's account, and changes with it.
 *
 * `server.codeium.com` refusing this request is a live, observed failure on
 * this machine (#114), not a hypothetical - so any process that does not
 * exit cleanly, and any output this cannot make sense of, is treated the
 * same as no families at all. Callers fall back to the bare account default,
 * which needs nothing from this list to keep working.
 */
export async function devinFamilies(devinBin = "devin"): Promise<DevinFamily[]> {
  let stdout: string;
  try {
    stdout = await run(devinBin, ["models", "list", "--format", "json"]);
  } catch {
    return [];
  }
  return parseFamilies(stdout);
}

function run(bin: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(bin, args, { stdio: ["ignore", "pipe", "ignore"] });
    } catch (error) {
      reject(error);
      return;
    }
    let out = "";
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      child.kill("SIGKILL");
      reject(new Error("devin models list timed out"));
    }, TIMEOUT_MS);
    child.stdout.on("data", (chunk) => { out += chunk; });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error(`devin models list exited ${code}`));
    });
  });
}

/**
 * `devin models list --format json`'s exact shape has not been directly
 * observed while building this - `server.codeium.com` refused every attempt
 * made on this machine (#114) - so this reads tolerantly rather than
 * assuming one field layout: whichever of a bare top-level array, a
 * `families` array or a `models` array is present, and whichever of
 * `family`/`slug`/`id`/`name` names each entry and `label`/`name`/`title`
 * describes it. A shape this cannot make sense of comes back as no
 * families, the same as the command failing outright - see `devinFamilies`.
 */
function parseFamilies(text: string): DevinFamily[] {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return [];
  }

  const list = Array.isArray(data)
    ? data
    : isRecord(data) && Array.isArray(data.families)
    ? data.families
    : isRecord(data) && Array.isArray(data.models)
    ? data.models
    : null;
  if (!list) return [];

  const byId = new Map<string, DevinFamily>();
  for (const entry of list) {
    if (!isRecord(entry)) continue;
    const id = firstString(entry, ["family", "slug", "id", "name"]);
    if (!id || byId.has(id)) continue;
    const label = firstString(entry, ["label", "name", "title"]) ?? id;
    byId.set(id, { id, label });
  }
  return [...byId.values()];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function firstString(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value !== "") return value;
  }
  return undefined;
}
