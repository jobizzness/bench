/**
 * What the developer has spent, as Anthropic counts it.
 *
 * The cockpit has always been able to say what a conversation cost. It could
 * never say what was left, and that is the number that decides whether to
 * start another specialist this afternoon or wait until the window turns
 * over. This asks the one endpoint that knows.
 *
 * Only an OAuth credential can be asked. A console API key is billed rather
 * than rationed, and has no windows to report - so a bench holding one shows
 * no panel at all rather than an empty one.
 */

import { readFileSync } from "node:fs";
import { isOauthToken } from "./anthropic-key.js";
import type { Usage, UsageWindow } from "../shared/usage.js";

export type { Usage, UsageWindow } from "../shared/usage.js";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * The windows we already have a short name for.
 *
 * A map rather than a rule, because "5-hour" and "7-day Opus" are what a
 * developer calls them, and no rule derives that from `seven_day_opus`.
 */
const KNOWN: Record<string, string> = {
  five_hour: "5-hour",
  seven_day: "7-day",
  seven_day_opus: "7-day Opus",
  seven_day_sonnet: "7-day Sonnet",
  seven_day_oauth_apps: "7-day apps",
};

/** A name for a window nobody here has heard of. Plain, but readable, and it
 * arrives on its own the day a new model gets a window of its own. */
function label(key: string): string {
  return KNOWN[key]
    ?? key.replace(/^five_hour/, "5-hour").replace(/^seven_day/, "7-day").replace(/_/g, " ");
}

/**
 * Every window in an answer, in the order the answer gave them.
 *
 * Read by shape rather than by name: a window is an entry with a number for
 * how full it is. The endpoint may send account flags alongside them and may
 * add windows we have never seen, and both should pass through this without
 * anyone editing the list above.
 */
export function windowsFrom(body: unknown): UsageWindow[] {
  if (typeof body !== "object" || body === null) return [];

  const windows: UsageWindow[] = [];
  for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
    if (typeof value !== "object" || value === null) continue;
    const held = value as { utilization?: unknown; resets_at?: unknown };
    if (typeof held.utilization !== "number" || !Number.isFinite(held.utilization)) continue;

    windows.push({
      key,
      label: label(key),
      // Overage can carry a window past its own limit. The bar stops at full;
      // the number printed beside it is the one that says what happened.
      percent: Math.min(100, Math.max(0, Math.round(held.utilization))),
      resetsAt: typeof held.resets_at === "string" ? held.resets_at : null,
    });
  }
  return windows;
}

/** Ask, as this token, what it has spent. */
export async function fetchUsage(token: string, fetchImpl: typeof fetch = fetch): Promise<Usage> {
  try {
    const res = await fetchImpl("https://api.anthropic.com/api/oauth/usage", {
      headers: {
        authorization: `Bearer ${token}`,
        "anthropic-beta": "oauth-2025-04-20",
        "anthropic-version": "2023-06-01",
      },
    });
    if (!res.ok) {
      return { available: false, reason: res.status === 401 || res.status === 403 ? "refused" : "unreachable" };
    }
    return { available: true, windows: windowsFrom(await res.json()) };
  } catch {
    // Offline, or an answer that was not JSON at all - a proxy's login page
    // reads as 200 and would otherwise become "nothing spent".
    return { available: false, reason: "unreachable" };
  }
}

/** Where the CLI keeps the login this machine already has. */
const CREDENTIALS = join(homedir(), ".claude", ".credentials.json");

/**
 * The OAuth token this machine is already logged in with, if it is still
 * good.
 *
 * Read rather than refreshed: renewing it belongs to the CLI, and a daemon
 * that writes to that file is a daemon that can log the developer out. An
 * expired token is treated as no token, because a 401 we can see coming is
 * not worth spending.
 */
export function machineToken(read: () => string | null, now: number): string | null {
  try {
    const raw = read();
    if (raw === null) return null;

    const held = (JSON.parse(raw) as { claudeAiOauth?: { accessToken?: unknown; expiresAt?: unknown } })
      .claudeAiOauth;
    if (typeof held?.accessToken !== "string" || held.accessToken === "") return null;
    if (typeof held.expiresAt === "number" && held.expiresAt <= now) return null;

    return held.accessToken;
  } catch {
    return null;
  }
}

/** The same, from where it actually lives. */
export function storedMachineToken(now: number = Date.now()): string | null {
  return machineToken(() => {
    try {
      return readFileSync(CREDENTIALS, "utf8");
    } catch {
      // No file is the ordinary case on a machine that authenticates some
      // other way. Not an error, and not worth a line in the log.
      return null;
    }
  }, now);
}

/** How long an answer stands. A hover is cheap to repeat; the endpoint is
 * not, and usage does not move fast enough for a minute to mislead. */
const FRESH_FOR = 60_000;

/**
 * Where a usage panel gets its numbers, credential and all.
 *
 * Resolved per request rather than at startup: the developer can save a key,
 * drop it, or log this machine in again while the daemon runs, and each of
 * those should change what the panel says without a restart.
 */
export function usageSource(deps: {
  /** The key the bench is holding, if any. Read, never served. */
  benchKey: () => string | null;
  machine?: (now: number) => string | null;
  fetchImpl?: typeof fetch;
  now?: () => number;
}): () => Promise<Usage> {
  const machine = deps.machine ?? storedMachineToken;
  const clock = deps.now ?? Date.now;
  let held: { token: string; at: number; usage: Usage } | null = null;

  return async () => {
    // The bench's own key first, and only if it is the kind that has windows
    // to report. Otherwise the login the specialists are actually spending.
    const bench = deps.benchKey();
    const token = bench !== null && isOauthToken(bench) ? bench : machine(clock());
    if (token === null) return { available: false, reason: "none" };

    const at = clock();
    if (held !== null && held.token === token && at - held.at < FRESH_FOR) return held.usage;

    const usage = await fetchUsage(token, deps.fetchImpl);
    // Only an answer is worth keeping. A failure held for a minute is a
    // credential that stays broken for a minute after it was fixed.
    if (usage.available) held = { token, at, usage };
    return usage;
  };
}
