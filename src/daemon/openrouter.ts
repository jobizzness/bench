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

import type { Balance, Credit } from "../shared/credit.js";
import type { Price, Rate, Tier } from "../shared/cost.js";

/**
 * Where OpenRouter's own routes live - `/key`, `/credits`, `/models` - for the
 * calls this daemon makes itself.
 */
export const BASE_URL = "https://openrouter.ai/api/v1";

/**
 * What ANTHROPIC_BASE_URL has to be set to, which is deliberately not the URL
 * above.
 *
 * The CLI builds its request as `${ANTHROPIC_BASE_URL}/v1/messages` - it adds
 * the `/v1` itself. So the base it is given must stop one level short, or
 * every turn is sent to `/api/v1/v1/messages`, which OpenRouter answers with a
 * 404 HTML page. That is not a hypothesis: `claude -p` was pointed at a local
 * server that recorded the path it asked for, and that is the path it asked
 * for.
 *
 * It failed the worst way it could. A 404 is not a refusal the CLI gives up
 * on, so it retried seven times with a doubling delay and only then died -
 * which reads as a specialist that hung and crashed, with nothing anywhere
 * saying the URL was wrong.
 *
 * Kept apart from BASE_URL rather than derived from it, because the two are
 * used by different clients with different rules about who adds the version,
 * and one constant serving both is exactly how they were collapsed before.
 */
export const CLI_BASE_URL = "https://openrouter.ai/api";

/**
 * The URL a CLI given this base will actually POST a turn to.
 *
 * Here so a test can assert the address that matters rather than the constant
 * that feeds it. The old test compared BASE_URL against a copy of itself,
 * which is true of any value and told nobody the requests were 404ing.
 */
export function messagesUrl(base: string): string {
  return `${base.replace(/\/+$/, "")}/v1/messages`;
}

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
  /**
   * What it charges, per million tokens, all four ways.
   *
   * This used to be the output price alone, and that was the wrong number to
   * have picked. A specialist re-sends its whole conversation on every tool
   * call, so its bill is mostly input and mostly cached input - which is
   * quoted separately at about a tenth of fresh. Output is the smallest term
   * and the one that varies least between models that read alike.
   *
   * It is the developer's own money: these turns go to their OpenRouter
   * account, not to a subscription already paid for. A picker that shows one
   * of the four numbers is asking them to choose blind and looking like it
   * is not.
   */
  price: Price;
}

/**
 * Whether this model could run a specialist at all.
 *
 * Tool use is the whole job. A specialist that cannot call a tool cannot read
 * a file, cannot edit one and cannot run a command - it can only talk about
 * doing so, which is not what anybody put it on the bench for.
 *
 * 69 of the 416 models OpenRouter serves are in this category, and they are
 * not obscure ones tucked away at the bottom: Google's image models and its
 * Lyria music models sort into the first block the picker draws, directly
 * above Gemini. Offering them is offering a specialist that provisions a
 * worktree, takes a prompt and can do nothing with it.
 */
function canRunASpecialist(supported: unknown): boolean {
  return Array.isArray(supported) && supported.includes("tools");
}

/**
 * One figure off a pricing record, converted to dollars per million tokens.
 *
 * Each is quoted per-token as a decimal string. Anything that is not a plain
 * non-negative number is reported as "not known" rather than shown: the
 * catalogue uses negative sentinels for models whose price is decided per
 * request, and drawing one of those as a price would be inventing a figure.
 */
function perMillion(quoted: Record<string, unknown> | undefined, key: string): number | null {
  const value = quoted?.[key];
  const each = Number(value);
  if (typeof value !== "string" || !Number.isFinite(each) || each < 0) return null;
  return each * 1_000_000;
}

/**
 * The four rates off a pricing record, with anything it does not name taken
 * from the rate behind it.
 *
 * The fallback is what makes an override readable. OpenRouter's tiers restate
 * only the figures that change: `google/gemini-3.1-pro-preview` gives its 200k
 * tier a new prompt, completion and cache-read price and says nothing about
 * cache-write, which means cache-write does not change at 200k - not that it
 * becomes unquoted. Reading the silence as "unknown" would push a model that
 * publishes all four rates into the pile that publishes none, and the fallback
 * from cache-write to fresh in shared/cost.ts would then charge the developer
 * ten times over for cached input above the threshold.
 *
 * For a base rate the fallback is all nulls, which makes this exactly the read
 * it has always been. Cache prices are absent for most of the catalogue, and
 * absent is not free - a model that does not cache re-reads the conversation
 * at full price every turn, which is what shared/cost.ts assumes on a null.
 */
function rateFrom(quoted: Record<string, unknown> | undefined, behind: Rate): Rate {
  return {
    fresh: perMillion(quoted, "prompt") ?? behind.fresh,
    cacheWrite: perMillion(quoted, "input_cache_write") ?? behind.cacheWrite,
    cacheRead: perMillion(quoted, "input_cache_read") ?? behind.cacheRead,
    out: perMillion(quoted, "completion") ?? behind.out,
  };
}

/**
 * The dearer rates a model charges for larger prompts, or nothing at all for
 * the models that have none.
 *
 * Nothing in Bench read `pricing.overrides` until now, and it is not a corner
 * of the catalogue: 58 of the 417 models OpenRouter serves have prompt-size
 * tiers, `qwen/qwen3-coder-flash` - this bench's own default reviewer - among
 * them. It charges $0.195/M up to 32k prompt tokens, $0.325/M above that and
 * $0.52/M above 128k, so a reviewer sent to read a whole branch is billed
 * 2.67x the rate Bench quoted it at and recorded against it.
 *
 * Only the size tiers are taken. Two models in the catalogue - the DeepSeek
 * vision previews - use the same `overrides` list to price by the clock
 * instead, with `utc_days` and `utc_start` and off-peak rates at night. Those
 * are skipped rather than approximated: a rate that halves at 4am UTC is not
 * something a picker can quote a developer this afternoon, and there is no
 * honest single number for it. Leaving them on the base rate is what happens
 * today and what will keep happening, which at least keeps the quote to a rate
 * the model genuinely charges at some hour.
 *
 * Sorted here so nothing downstream has to trust OpenRouter's ordering.
 */
function tiersFrom(quoted: Record<string, unknown> | undefined, base: Rate): Tier[] {
  const rows = quoted?.["overrides"];
  if (!Array.isArray(rows)) return [];

  return rows
    .flatMap((row): Tier[] => {
      const override = row as Record<string, unknown>;
      const from = override["min_prompt_tokens"];
      if (typeof from !== "number" || !Number.isFinite(from) || from <= 0) return [];
      return [{ fromPromptTokens: from, ...rateFrom(override, base) }];
    })
    .sort((a, b) => a.fromPromptTokens - b.fromPromptTokens);
}

/**
 * What OpenRouter charges per million tokens, in dollars, all four ways, at
 * whatever size of prompt.
 *
 * `tiers` is left off entirely rather than set to an empty list for the 359
 * models that have none, so a price parsed today is the same object a price
 * parsed before tiers existed was, and compares equal to one.
 */
function prices(pricing: unknown): Price {
  const quoted = pricing as Record<string, unknown> | undefined;
  const base = rateFrom(quoted, { fresh: null, cacheWrite: null, cacheRead: null, out: null });
  const tiers = tiersFrom(quoted, base);

  return { ...base, ...(tiers.length > 0 ? { tiers } : {}) };
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
    const model = row as {
      id?: unknown; name?: unknown; context_length?: unknown;
      supported_parameters?: unknown; pricing?: unknown;
    };
    if (typeof model.id !== "string" || model.id === "") return [];
    // Batch variants are the same model on a slower, cheaper queue. A
    // specialist is interactive, so they are noise in this list.
    if (model.id.endsWith(":batch")) return [];
    // Filtered here rather than dimmed in the picker, because there is no
    // sense in which the developer could pick one of these and be right. A
    // list is more useful for being shorter and entirely true than for being
    // complete.
    if (!canRunASpecialist(model.supported_parameters)) return [];

    const contextLength = typeof model.context_length === "number" && model.context_length > 0
      ? model.context_length
      : null;

    return [{
      id: model.id,
      name: typeof model.name === "string" && model.name !== "" ? model.name : model.id,
      vendor: vendorOf(model.id),
      contextLength,
      price: prices(model.pricing),
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
    ANTHROPIC_BASE_URL: CLI_BASE_URL,
    ANTHROPIC_API_KEY: opts.key,
    ...(opts.contextLength ? { CLAUDE_CODE_MAX_CONTEXT_TOKENS: String(opts.contextLength) } : {}),
  };
}

/**
 * What the account has left of the credit it bought.
 *
 * A second route, because OpenRouter keeps the two facts apart and `/key` only
 * knows the first: what this key has spent, and what cap the key was given.
 * Neither of those is the balance. A pay-as-you-go key has no cap at all, so a
 * meter reading `/key` alone tells a developer with a dollar left that there
 * is "no ceiling on this key" - true, reassuring, and the opposite of the
 * thing they needed to hear.
 *
 * What is left is OpenRouter's own two numbers subtracted from each other,
 * rather than the purchased credit minus the spend `/key` reported. The two
 * routes are separately-lagged accumulators - `/credits` is the fresher, and
 * it counts every key on the account rather than this one - so mixing them
 * would produce a figure neither route ever said.
 *
 * Every failure here is "the balance is not known" rather than a failed
 * reading, which is why it is a route of its own with its own catch. A key
 * whose spend is known and whose balance is not still has something true to
 * report, and dropping the whole reading would trade one missing number for
 * two.
 */
async function accountBalance(key: string, fetchImpl: typeof fetch): Promise<Balance | null> {
  try {
    const res = await fetchImpl(`${BASE_URL}/credits`, {
      headers: { authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;

    const body = await res.json() as { data?: { total_credits?: unknown; total_usage?: unknown } };
    const purchased = body?.data?.total_credits;
    const used = body?.data?.total_usage;
    // Both or neither. Half of a subtraction is not a balance, and defaulting
    // the missing half to zero would invent the number the meter exists to
    // report.
    if (typeof purchased !== "number" || typeof used !== "number") return null;

    return { purchased, remaining: purchased - used };
  } catch {
    return null;
  }
}

/**
 * What this key has spent, the ceiling it was given, and what is left of the
 * account's credit.
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
      // Asked only once the key has answered for itself. A key OpenRouter has
      // turned away has no balance worth asking about, and going second means
      // trouble on this route can only ever cost the balance, never the spend.
      balance: await accountBalance(key, fetchImpl),
    };
  } catch {
    return { available: false, reason: "unreachable" };
  }
}

/**
 * What a single request actually cost, in dollars, or null if that cannot be
 * established.
 *
 * This exists because no price table can be made right. Bench's estimate was
 * measured against the account's real charges over 500 requests today: $7.02
 * estimated, $10.24 billed, wrong by 1.46x. The cause is not a stale figure or
 * a missed cache discount - it is that OpenRouter's catalogue quotes one
 * provider's price and bills at whichever provider actually served the
 * request. `deepseek/deepseek-v4-pro` is listed at $0.87/M and the provider
 * that served it charged about $1.60/M. Which provider takes a request is
 * decided per request, after the fact, by OpenRouter's own routing. There is
 * no number Bench can hold that predicts it.
 *
 * So the settled figure is fetched instead of computed. It needs no special
 * key - checked against the live service today on an ordinary inference key,
 * and all 500 historical ids resolved.
 *
 * Null on anything unexpected, and never a guess. A cost this function is not
 * certain of is worse than no cost at all, because the entire point of the
 * change is to stop presenting a figure that looks settled and is not.
 */
export async function settledCost(
  id: string,
  key: string,
  fetchImpl: typeof fetch = fetch,
): Promise<number | null> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const res = await fetchImpl(`${BASE_URL}/generation?id=${encodeURIComponent(id)}`, {
        headers: { authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(10_000),
      });

      // A 404 is the one failure worth asking twice about, and the reason is
      // a race rather than a flake: the generation record is written a moment
      // after the response finishes streaming, so a turn that prices itself
      // the instant it ends can beat OpenRouter to its own bookkeeping. One
      // retry, because the same 404 is also what a genuinely unknown id
      // returns - confirmed against the live service, which answers
      // `Generation <id> not found` with a 404 for both - and there is no way
      // to tell those apart from here. Asking forever would mean a mistyped
      // id costing a fixed delay on every turn for ever.
      if (res.status === 404 && attempt === 0) {
        await new Promise((wake) => setTimeout(wake, SETTLE_WAIT));
        continue;
      }
      if (!res.ok) return null;

      const body = await res.json() as { data?: { total_cost?: unknown } };
      const cost = body?.data?.total_cost;
      // Not a number is not a cost. A body that came back 200 without the
      // field is a proxy's login page or a shape that has moved, and reading
      // zero out of either would report the turn as free.
      if (typeof cost !== "number" || !Number.isFinite(cost) || cost < 0) return null;
      return cost;
    } catch {
      // Offline, DNS, or the timeout above. Says nothing about the cost.
      return null;
    }
  }

  return null;
}

/** How long to leave OpenRouter to write its own record before asking a
 * second time. Long enough to lose the race by, short enough that a turn
 * being priced does not feel like it has stopped. */
const SETTLE_WAIT = 400;

/**
 * What a whole turn actually cost, and how much of it could not be priced.
 *
 * The second number is the point of this shape. A turn is many requests - a
 * specialist re-sends its conversation on every tool call - so a total is a
 * sum over a list of ids, and a sum with a gap in it looks exactly like a sum
 * without one. Presenting a partial total as the bill is the same failure the
 * estimate made, only harder to spot, so the count of what is missing travels
 * with the money rather than being logged somewhere and lost.
 */
export interface SettledTotal {
  /**
   * Dollars charged for the ids that could be priced. The whole of the turn
   * when `unpriced` is zero, and a floor on it otherwise - never present this
   * on its own without reading the field below.
   */
  dollars: number;
  /** How many ids returned a settled cost. */
  priced: number;
  /** How many did not. Anything above zero means `dollars` is part of a bill,
   * not a bill. */
  unpriced: number;
}

/**
 * How many lookups to have in flight at once.
 *
 * A long turn can carry dozens of ids and every one is its own round trip, so
 * firing them all at once is a burst of forty-odd requests at OpenRouter for
 * one turn ending - which is how a rate limit turns a priced turn into an
 * unpriced one. Serial is the other extreme and would put a visible pause on
 * the end of every turn.
 *
 * Six is a judgement rather than a measurement, and it is a new pattern here:
 * the rest of the daemon either fans out unbounded (RefIndex, one `gh` per
 * issue) or serialises to one (the store's write chain), and neither of those
 * is right for a few dozen cheap reads of somebody else's API.
 */
const LOOKUPS_AT_ONCE = 6;

/**
 * Add up what a turn really cost, id by id.
 *
 * Bounded rather than a `Promise.all` over the lot - see above. The workers
 * share one cursor instead of being handed a slice each, so a single slow
 * lookup holds up only itself: slicing would leave five workers idle while
 * the sixth finished a chunk it happened to get the slow ids in.
 *
 * Every id is allowed to fail on its own. One 404 in a turn of thirty should
 * cost that request's cost and nothing else, which is why this counts failures
 * rather than abandoning the total on the first one.
 */
export async function settledCostOfTurn(
  ids: readonly string[],
  key: string,
  fetchImpl: typeof fetch = fetch,
): Promise<SettledTotal> {
  const total: SettledTotal = { dollars: 0, priced: 0, unpriced: 0 };
  let next = 0;

  const worker = async (): Promise<void> => {
    while (next < ids.length) {
      // Safe without a lock: nothing yields between the read and the
      // increment, and this runtime is single-threaded.
      const id = ids[next++]!;
      const cost = await settledCost(id, key, fetchImpl);
      if (cost === null) {
        total.unpriced += 1;
      } else {
        total.dollars += cost;
        total.priced += 1;
      }
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(LOOKUPS_AT_ONCE, ids.length) }, () => worker()),
  );

  return total;
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
