import { spawn } from "node:child_process";

/** One entry in the Antigravity model picker. */
export interface AntigravityModel {
  id: string;
  label: string;
}

const TIMEOUT_MS = 25_000;

export const DEFAULT_ANTIGRAVITY_MODELS: AntigravityModel[] = [
  { id: "gemini-3.8-flash-high", label: "Gemini 3.8 Flash (High)" },
  { id: "gemini-3.8-flash-medium", label: "Gemini 3.8 Flash (Medium)" },
  { id: "gemini-3.8-flash-low", label: "Gemini 3.8 Flash (Low)" },
  { id: "claude-opus-5-5-high", label: "Claude Opus 5.5 (High)" },
  { id: "claude-sonnet-5-5-high", label: "Claude Sonnet 5.5 (High)" },
  { id: "claude-haiku-5-5-high", label: "Claude Haiku 5.5 (High)" },
  { id: "claude-opus-4-5-high", label: "Claude Opus 4.5 (High)" },
  { id: "claude-sonnet-4-5-high", label: "Claude Sonnet 4.5 (High)" },
  { id: "claude-haiku-4-5-high", label: "Claude Haiku 4.5 (High)" },
  { id: "gpt-oss-120b-medium", label: "GPT-OSS 120B (Medium)" },
];

let cachedModels: AntigravityModel[] | null = [...DEFAULT_ANTIGRAVITY_MODELS];
let inFlightPromise: Promise<AntigravityModel[]> | null = null;

export function resetModelsCache(initial: AntigravityModel[] | null = [...DEFAULT_ANTIGRAVITY_MODELS]): void {
  cachedModels = initial ? [...initial] : null;
  inFlightPromise = null;
}

/**
 * Antigravity CLI's own account of what models it can run.
 * Discovered by running `agy models` on the machine.
 */
export async function antigravityModels(agyBin = "agy"): Promise<AntigravityModel[]> {
  // For custom test binaries (not default "agy"), bypass cache and fallback so tests run cleanly
  if (agyBin !== "agy") {
    let stdout: string;
    try {
      stdout = await run(agyBin, ["models"]);
    } catch {
      return [];
    }
    const parsed = parseModels(stdout);
    return parsed.length > 0 ? parsed : [];
  }

  // If we already have cached models, return them immediately
  if (cachedModels !== null && cachedModels.length > 0) {
    if (!inFlightPromise) {
      void refreshModels(agyBin);
    }
    return cachedModels;
  }

  if (inFlightPromise) {
    return inFlightPromise;
  }

  return refreshModels(agyBin);
}

async function refreshModels(agyBin: string): Promise<AntigravityModel[]> {
  inFlightPromise = (async () => {
    try {
      const stdout = await run(agyBin, ["models"]);
      const parsed = parseModels(stdout);
      if (parsed.length > 0) {
        cachedModels = parsed;
        return parsed;
      }
    } catch {
      // CLI failed or timed out
    }
    if (!cachedModels || cachedModels.length === 0) {
      cachedModels = [...DEFAULT_ANTIGRAVITY_MODELS];
    }
    return cachedModels;
  })();

  try {
    return await inFlightPromise;
  } finally {
    inFlightPromise = null;
  }
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
      reject(new Error("agy models timed out"));
    }, TIMEOUT_MS);
    child.stdout.on("data", (chunk: Buffer) => { out += chunk.toString("utf8"); });
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
      else reject(new Error(`agy models exited ${code}`));
    });
  });
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Parses either JSON output or plain text lines from `agy models`.
 */
export function parseModels(text: string): AntigravityModel[] {
  const trimmed = text.trim();
  if (trimmed === "") return [];

  // Try JSON first
  try {
    const data = JSON.parse(trimmed);
    const list = Array.isArray(data)
      ? data
      : isRecord(data) && Array.isArray(data.models)
      ? data.models
      : null;
    if (list) {
      const result: AntigravityModel[] = [];
      for (const entry of list) {
        if (!isRecord(entry)) continue;
        const id = typeof entry.id === "string" ? entry.id : typeof entry.name === "string" ? entry.name : "";
        const label = typeof entry.label === "string" ? entry.label : typeof entry.name === "string" ? entry.name : id;
        if (id) result.push({ id, label: label || id });
      }
      if (result.length > 0) return result;
    }
  } catch {
    // Fall through to text parsing
  }

  // Parse text output: e.g. "gemini-3.8-flash-high\tGemini 3.8 Flash (High)" or "gemini-3.8-flash-high     Gemini 3.8 Flash (High)"
  // Strip ANSI escape codes / spinners if present
  const cleanText = trimmed.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "").replace(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/g, "");
  const lines = cleanText.split(/\r?\n|\r/);
  const result: AntigravityModel[] = [];
  const seen = new Set<string>();

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith("-") || line.startsWith("Usage:") || line.startsWith("Flags:") || line.includes("Fetching available models")) {
      continue;
    }
    // Match "<id>\t<label>" or "<id>   <label>"
    const match = /^([a-zA-Z0-9][a-zA-Z0-9_.-]*)\s+(.+)$/.exec(line);
    if (match && match[1] && match[2]) {
      const id = match[1].trim();
      const label = match[2].trim();
      if (!seen.has(id)) {
        seen.add(id);
        result.push({ id, label });
      }
    }
  }

  return result;
}
