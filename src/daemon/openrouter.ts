/**
 * Running a specialist on somebody other than Anthropic, by pointing the CLI
 * at OpenRouter.
 *
 * Claude Code speaks one protocol, and OpenRouter serves it: `/v1/messages`
 * in Anthropic's own request and error shape, behind the same `x-api-key` the
 * CLI already sends. So the whole of the integration is three environment
 * variables on the child process. There is nothing to install, nothing to
 * supervise, and no second process that can be down.
 *
 * This replaced a local translating proxy - a Python service Bench started in
 * Docker or uv, on a port it had to allocate and health-check. That worked,
 * but it could only reach two models at a time (the proxy remapped the
 * `sonnet` and `haiku` aliases and nothing else), it could not reach Opus or
 * Fable at all, and the model names it would route were a hardcoded list in
 * somebody else's repository that had gone stale. All of that is gone.
 *
 * Anthropic's own models deliberately do not come this way. They go straight
 * to Anthropic on the developer's own login or key, because that is what
 * bills the subscription they are already paying for - routing them through
 * OpenRouter would quietly move that spend somewhere else.
 */

import type { Credit } from "../shared/credit.js";

/** Where OpenRouter answers Anthropic's protocol. */
export const BASE_URL = "https://openrouter.ai/api/v1";

/**
 * Whether a model id belongs to OpenRouter rather than to Anthropic directly.
 *
 * The slash is the whole test, and it is not a guess: every OpenRouter id is
 * `vendor/model`, and none of the aliases the CLI takes for Anthropic's own
 * models contains one. A full Anthropic model name - `claude-opus-5` - has no
 * slash either, so a record written by hand still goes direct.
 */
export function isOpenRouterModel(id: string): boolean {
  return id.includes("/");
}

/** The vendor half of an OpenRouter id, which is what the picker groups on. */
export function vendorOf(id: string): string {
  return id.split("/")[0] ?? "";
}

/** One model, as much of it as the cockpit needs. */
export interface Listed {
  id: string;
  /** OpenRouter's display name, e.g. "Google: Gemini 3.7 Flash". */
  name: string;
  /** The `google` in `google/gemini-3.7-flash`. */
  vendor: string;
  /**
   * How much the model will actually hold.
   *
   * Carried because the CLI does not know these models and assumes 200k for
   * anything it does not recognise - so a million-token model would be
   * auto-compacted at a fifth of its window unless it is told otherwise.
   */
  contextLength: number | null;
}

/**
 * What may be said about a key, in the same three answers the Anthropic check
 * uses: wrong is a typo to fix now, unreachable is a machine that happens to
 * be offline and should still be allowed to hold a key.
 */
export type KeyCheck = "ok" | "refused" | "unreachable";

/**
 * Ask OpenRouter, as this key, for the cheapest thing it will answer.
 *
 * Worth the round trip: the CLI does not fail fast on a rejected key. It
 * retries a 401 with a doubling delay, so a typo does not read as a typo - it
 * reads as a specialist that hangs and then dies.
 */
export async function checkKey(key: string, fetchImpl: typeof fetch = fetch): Promise<KeyCheck> {
  try {
    const res = await fetchImpl(`${BASE_URL}/key`, {
      headers: { authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (res.ok) return "ok";
    return res.status === 401 || res.status === 403 ? "refused" : "unreachable";
  } catch {
    // No answer at all: offline, DNS, something in the way. Says nothing
    // about the key.
    return "unreachable";
  }
}

/**
 * Every model OpenRouter currently serves.
 *
 * Fetched rather than kept in a list here, and that is the point of the
 * change: the hand-maintained list this replaces had gone stale, and being
 * stale was not visible - it named models that no longer existed while the
 * ones people wanted were missing. A catalogue that is read from the service
 * cannot drift from it.
 *
 * No key needed. The listing is public, so the picker fills in even before a
 * key has been set - which is what lets the modal show what a key would buy.
 */
export async function catalogue(fetchImpl: typeof fetch = fetch): Promise<Listed[]> {
  const res = await fetchImpl(`${BASE_URL}/models`, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`OpenRouter answered ${res.status} for its model list`);

  const body = await res.json() as { data?: unknown };
  const rows = Array.isArray(body.data) ? body.data : [];

  return rows.flatMap((row): Listed[] => {
    const model = row as { id?: unknown; name?: unknown; context_length?: unknown };
    if (typeof model.id !== "string" || model.id === "") return [];
    // Batch variants are the same model on a slower, cheaper queue. A
    // specialist is interactive, so they are noise in this list.
    if (model.id.endsWith(":batch")) return [];

    const contextLength = typeof model.context_length === "number" && model.context_length > 0
      ? model.context_length
      : null;

    return [{
      id: model.id,
      name: typeof model.name === "string" && model.name !== "" ? model.name : model.id,
      vendor: vendorOf(model.id),
      contextLength,
    }];
  });
}

/**
 * The environment a child `claude` needs to be answered by OpenRouter.
 *
 * Three variables and no more. The key goes in ANTHROPIC_API_KEY because that
 * is the one the CLI puts on `x-api-key`, and OpenRouter accepts a key on
 * that header as readily as on Authorization - verified against the live
 * service rather than assumed.
 *
 * The context window is set explicitly because the CLI has never heard of
 * these models. Left alone it assumes 200k and says so, then auto-compacts
 * there - which on a million-token model throws away four fifths of what the
 * developer is paying for. Omitted when OpenRouter does not say, rather than
 * guessed: a wrong window is worse than the CLI's own honest default.
 */
export function sessionEnv(opts: { key: string; contextLength?: number | null }): Record<string, string> {
  return {
    ANTHROPIC_BASE_URL: BASE_URL,
    ANTHROPIC_API_KEY: opts.key,
    ...(opts.contextLength ? { CLAUDE_CODE_MAX_CONTEXT_TOKENS: String(opts.contextLength) } : {}),
  };
}

/**
 * What this key has spent, and the ceiling it was given.
 *
 * The same `/key` route the check above uses - it answers both questions at
 * once - but read for its body rather than its status, and reported as the
 * three-way answer the meter needs. "Refused" and "could not ask" are not the
 * same thing to draw: one is a key to fix, the other is a number that will be
 * there again in a minute.
 *
 * A 200 whose body is not the promised shape counts as not having reached
 * OpenRouter at all. That is a captive portal or a proxy's login page, and
 * reporting "$0.00 spent" from one would be reporting a number nobody said.
 */
export async function credit(key: string, fetchImpl: typeof fetch = fetch): Promise<Credit> {
  try {
    const res = await fetchImpl(`${BASE_URL}/key`, {
      headers: { authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      return { available: false, reason: res.status === 401 || res.status === 403 ? "refused" : "unreachable" };
    }

    const body = await res.json() as { data?: { usage?: unknown; limit?: unknown } };
    const data = body?.data;
    if (typeof data !== "object" || data === null) return { available: false, reason: "unreachable" };

    return {
      available: true,
      // A key that has never been used may come back without the field at
      // all, which is nothing spent rather than nothing known.
      spent: typeof data.usage === "number" ? data.usage : 0,
      // Null is the ordinary answer here: a pay-as-you-go key has no ceiling,
      // and that is not the same as a ceiling of zero.
      limit: typeof data.limit === "number" ? data.limit : null,
    };
  } catch {
    return { available: false, reason: "unreachable" };
  }
}

/** How long an answer stands, matching the Anthropic panel's minute. A hover
 * is cheap to repeat; the endpoint is not, and a spend that has moved by
 * less than a minute's work is not a spend worth re-asking for. */
const FRESH_FOR = 60_000;

/**
 * Where the credit meter gets its number, key and all.
 *
 * The key is read per call rather than captured, because the developer can
 * save one or drop one while the daemon runs and the meter should follow
 * without a restart. Holding no key is "nothing to report" rather than a
 * failure - a bench that only ever runs Anthropic models is not broken.
 */
export function creditSource(deps: {
  /** The key the bench is holding, if any. Read, never served. */
  key: () => string | null;
  fetchImpl?: typeof fetch;
  now?: () => number;
}): () => Promise<Credit> {
  const clock = deps.now ?? Date.now;
  let held: { key: string; at: number; credit: Credit } | null = null;

  return async () => {
    const key = deps.key();
    if (key === null) return { available: false, reason: "none" };

    const at = clock();
    // Keyed on the key as well as the clock: a developer who has just
    // replaced a key is asking about the new one, however fresh the last
    // answer was.
    if (held !== null && held.key === key && at - held.at < FRESH_FOR) return held.credit;

    const answer = await credit(key, deps.fetchImpl);
    // Only an answer is worth keeping. A failure held for a minute is a key
    // that stays broken for a minute after it was fixed.
    if (answer.available) held = { key, at, credit: answer };
    return answer;
  };
}
