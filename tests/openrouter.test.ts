import { describe, it, expect } from "vitest";
import {
  BASE_URL,
  CLI_BASE_URL,
  messagesUrl,
  isOpenRouterModel,
  vendorOf,
  checkKey,
  catalogue,
  sessionEnv,
  credit,
  creditSource,
  settledCost,
  settledCostOfTurn,
} from "../src/daemon/openrouter.js";

/** A fetch that answers one body, and records what it was asked. */
function serving(body: unknown, status = 200) {
  const seen: Array<{ url: string; auth: string | null }> = [];
  const impl = (async (url: string, init?: RequestInit) => {
    seen.push({ url: String(url), auth: new Headers(init?.headers).get("authorization") });
    return new Response(JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
  return { impl, seen };
}

describe("which models go through OpenRouter", () => {
  it("is decided by the slash, which every OpenRouter id has", () => {
    expect(isOpenRouterModel("google/gemini-3.7-flash")).toBe(true);
    expect(isOpenRouterModel("openai/gpt-5.6-luna")).toBe(true);
  });

  it("leaves Anthropic's aliases alone", () => {
    // These go straight to Anthropic on the developer's own login, because
    // that is what bills the subscription they already pay for.
    for (const id of ["opus", "sonnet", "fable", "haiku"]) {
      expect(isOpenRouterModel(id)).toBe(false);
    }
  });

  it("leaves a full Anthropic model name alone too", () => {
    // A record written by hand, or one older than this file.
    expect(isOpenRouterModel("claude-opus-5")).toBe(false);
  });

  it("reads the vendor off the front, which is how the picker groups", () => {
    expect(vendorOf("google/gemini-3.7-flash")).toBe("google");
    expect(vendorOf("meta-llama/llama-4")).toBe("meta-llama");
  });
});

describe("what a specialist is given", () => {
  it("points the CLI at OpenRouter and hands it the key", () => {
    // Verified against the live service: OpenRouter serves Anthropic's
    // /v1/messages and accepts a key on x-api-key, which is the header the
    // CLI puts ANTHROPIC_API_KEY on.
    expect(sessionEnv({ key: "sk-or-v1-abc", contextLength: 1_048_576 })).toEqual({
      ANTHROPIC_BASE_URL: "https://openrouter.ai/api",
      ANTHROPIC_API_KEY: "sk-or-v1-abc",
      CLAUDE_CODE_MAX_CONTEXT_TOKENS: "1048576",
    });
  });

  it("gives a base URL the CLI turns into OpenRouter's real messages route", () => {
    // The invariant that matters, and the one this file used to miss: the
    // assertion above only ever compared a constant against itself, so the
    // base could be - and was - a URL the CLI resolves to a 404.
    //
    // The CLI appends `/v1/messages` to ANTHROPIC_BASE_URL. Observed, not
    // assumed: `claude -p` was pointed at a local server that logged the path
    // it was asked for, and with a base ending `/api/v1` it asked for
    // `/api/v1/v1/messages`.
    expect(messagesUrl(sessionEnv({ key: "k" }).ANTHROPIC_BASE_URL))
      .toBe("https://openrouter.ai/api/v1/messages");
  });

  it("keeps the CLI's base and the daemon's own base apart", () => {
    // They are genuinely different URLs and one constant cannot be both:
    // `/key` and `/models` are served under `/api/v1`, while the CLI needs a
    // base one level up because it adds the `/v1` itself. Collapsing them is
    // what broke every OpenRouter turn.
    expect(CLI_BASE_URL).toBe("https://openrouter.ai/api");
    expect(BASE_URL).toBe("https://openrouter.ai/api/v1");
    expect(BASE_URL).not.toBe(CLI_BASE_URL);
  });

  it("tells the CLI how much the model actually holds", () => {
    // The CLI has never heard of these models. Left alone it assumes 200k and
    // auto-compacts there, which on a million-token model throws away four
    // fifths of what the developer is paying for.
    expect(sessionEnv({ key: "k", contextLength: 200_000 }).CLAUDE_CODE_MAX_CONTEXT_TOKENS)
      .toBe("200000");
  });

  it("says nothing about the window when OpenRouter did not say", () => {
    // A wrong window is worse than the CLI's own honest default.
    expect(sessionEnv({ key: "k", contextLength: null }))
      .not.toHaveProperty("CLAUDE_CODE_MAX_CONTEXT_TOKENS");
    expect(sessionEnv({ key: "k" }))
      .not.toHaveProperty("CLAUDE_CODE_MAX_CONTEXT_TOKENS");
  });
});

describe("checking a key before it is kept", () => {
  it("asks OpenRouter, as that key", async () => {
    const { impl, seen } = serving({ data: {} });
    expect(await checkKey("sk-or-v1-good", impl)).toBe("ok");
    expect(seen[0].url).toBe(`${BASE_URL}/key`);
    expect(seen[0].auth).toBe("Bearer sk-or-v1-good");
  });

  it("tells a refusal from a machine that is simply offline", async () => {
    // Two different problems: one is a typo to fix now, the other is a laptop
    // on a train that should still be allowed to hold a key.
    const refused = serving({}, 401).impl;
    const broken = serving({}, 503).impl;
    const down = (async () => { throw new Error("dns"); }) as unknown as typeof fetch;

    expect(await checkKey("k", refused)).toBe("refused");
    expect(await checkKey("k", broken)).toBe("unreachable");
    expect(await checkKey("k", down)).toBe("unreachable");
  });
});

describe("the catalogue", () => {
  /** Rows in the shape OpenRouter actually serves them. */
  const tools = ["tools", "max_tokens"];
  const body = {
    data: [
      {
        id: "google/gemini-3.7-flash", name: "Google: Gemini 3.7 Flash",
        context_length: 1048576, supported_parameters: tools,
        pricing: { prompt: "0.000000375", completion: "0.000001875" },
      },
      {
        id: "google/gemini-3.7-flash:batch", name: "Google: Gemini 3.7 Flash (batch)",
        context_length: 1048576, supported_parameters: tools,
        pricing: { prompt: "0.0000001", completion: "0.0000009" },
      },
      {
        id: "openai/gpt-5.6-luna", name: "OpenAI: GPT-5.6 Luna",
        context_length: 1050000, supported_parameters: tools,
        pricing: {
          prompt: "0.0000012", completion: "0.00001",
          input_cache_read: "0.00000012", input_cache_write: "0.0000015",
        },
      },
      {
        id: "weird/no-context", name: "No context given",
        supported_parameters: tools, pricing: { prompt: "0", completion: "0" },
      },
      // Real rows, both of them: an image model and a music model, and both
      // sort into the first block the picker used to draw.
      {
        id: "google/lyria-3-pro-preview", name: "Google: Lyria 3 Pro Preview",
        context_length: 1048576, supported_parameters: ["max_tokens"],
        pricing: { prompt: "0.000001", completion: "0.000001" },
      },
      {
        id: "google/gemini-3.1-flash-image", name: "Google: Nano Banana 2",
        context_length: 131072, supported_parameters: [],
        pricing: { prompt: "0.000001", completion: "0.000001" },
      },
      // Priced per request rather than per token, which the catalogue reports
      // as a negative sentinel.
      {
        id: "openrouter/auto", name: "Auto Router",
        context_length: 200000, supported_parameters: tools,
        pricing: { prompt: "-1", completion: "-1" },
      },
      { id: "", name: "nameless", supported_parameters: tools },
    ],
  };

  it("reads id, name, vendor, window and price off each model", async () => {
    const models = await catalogue(serving(body).impl);
    expect(models[0]).toEqual({
      id: "google/gemini-3.7-flash",
      name: "Google: Gemini 3.7 Flash",
      vendor: "google",
      contextLength: 1048576,
      price: { fresh: 0.375, cacheWrite: null, cacheRead: null, out: 1.875 },
    });
  });

  it("drops the batch variants, which are the same model on a slower queue", async () => {
    // A specialist is interactive, so they are noise in this list.
    const models = await catalogue(serving(body).impl);
    expect(models.some((m) => m.id.endsWith(":batch"))).toBe(false);
  });

  it("drops the models that could not run a specialist if they were picked", async () => {
    // Tool use is the whole job: without it a specialist cannot read a file,
    // edit one or run a command. 69 of the models OpenRouter serves are in
    // this category, and the picker used to offer every one of them - the
    // image and music models among them, sorted to the very top under Google.
    const models = await catalogue(serving(body).impl);
    expect(models.map((m) => m.id)).not.toContain("google/lyria-3-pro-preview");
    expect(models.map((m) => m.id)).not.toContain("google/gemini-3.1-flash-image");
  });

  it("carries a missing window as null rather than inventing one", async () => {
    const models = await catalogue(serving(body).impl);
    expect(models.find((m) => m.id === "weird/no-context")!.contextLength).toBe(null);
  });

  it("reports a price that is not per-token as unknown rather than as a figure", async () => {
    // The catalogue quotes a negative sentinel for models priced per request.
    // Drawing one of those as a price would be inventing a number.
    const models = await catalogue(serving(body).impl);
    expect(models.find((m) => m.id === "openrouter/auto")!.price.out).toBe(null);
    expect(models.find((m) => m.id === "weird/no-context")!.price.out).toBe(0);
  });

  it("carries the cache prices, which are what an agentic turn mostly spends", async () => {
    // A specialist re-sends its conversation on every tool call, so most of
    // what it pays for is cached input. Quoting the output price alone - which
    // is what this used to do - is quoting the smallest term in the bill.
    const models = await catalogue(serving(body).impl);

    expect(models.find((m) => m.id === "openai/gpt-5.6-luna")!.price).toEqual({
      fresh: 1.2, cacheWrite: 1.5, cacheRead: 0.12, out: 10,
    });
  });

  it("leaves a cache price unquoted rather than assuming it is free", async () => {
    // Most of the catalogue does not quote one. Absent is not free: a model
    // that does not cache re-reads the whole conversation at full price.
    const models = await catalogue(serving(body).impl);
    const gemini = models.find((m) => m.id === "google/gemini-3.7-flash")!;

    expect(gemini.price.cacheRead).toBeNull();
    expect(gemini.price.cacheWrite).toBeNull();
  });

  it("skips a row with no id at all", async () => {
    const models = await catalogue(serving(body).impl);
    expect(models.map((m) => m.id)).toEqual([
      "google/gemini-3.7-flash", "openai/gpt-5.6-luna", "weird/no-context", "openrouter/auto",
    ]);
  });

  it("says so when OpenRouter will not answer", async () => {
    await expect(catalogue(serving({}, 500).impl)).rejects.toThrow(/500/);
  });

  it("survives a body that is not the shape it expected", async () => {
    // The cockpit has to open whatever comes back. An empty picker beats a
    // daemon that threw.
    await expect(catalogue(serving({ nope: true }).impl)).resolves.toEqual([]);
  });
});

/**
 * The dearer rates OpenRouter charges for larger prompts.
 *
 * Nothing in Bench read `pricing.overrides` until now, and it is not a corner
 * of the catalogue: 58 of the 417 models have prompt-size tiers, and
 * `qwen/qwen3-coder-flash` - this bench's own default reviewer - is one of
 * them. The rows below are copied from the live catalogue rather than
 * invented.
 */
describe("a model that charges more for a bigger prompt", () => {
  const tools = ["tools", "max_tokens"];
  const body = {
    data: [
      {
        id: "qwen/qwen3-coder-flash", name: "Qwen: Qwen3 Coder Flash",
        context_length: 262144, supported_parameters: tools,
        pricing: {
          prompt: "0.000000195", completion: "0.000000975",
          input_cache_read: "0.000000039", input_cache_write: "0.00000024375",
          overrides: [
            {
              min_prompt_tokens: 32000, prompt: "0.000000325", completion: "0.000001625",
              input_cache_read: "0.000000065", input_cache_write: "0.00000040625",
            },
            {
              min_prompt_tokens: 128000, prompt: "0.00000052", completion: "0.0000026",
              input_cache_read: "0.000000104", input_cache_write: "0.00000065",
            },
          ],
        },
      },
      {
        // Its 200k tier restates three of the four rates and says nothing
        // about cache-write, which means cache-write does not change.
        id: "google/gemini-3.1-pro-preview", name: "Google: Gemini 3.1 Pro Preview",
        context_length: 1048576, supported_parameters: tools,
        pricing: {
          prompt: "0.000002", completion: "0.000012",
          input_cache_read: "0.0000002", input_cache_write: "0.000000375",
          overrides: [{
            min_prompt_tokens: 200000, prompt: "0.000004", completion: "0.000018",
            input_cache_read: "0.0000004",
          }],
        },
      },
      {
        // Two models in the live catalogue price by the clock through the very
        // same `overrides` list - off-peak rates at night, by UTC day.
        id: "deepseek/deepseek-v4-flash-vision-exp", name: "DeepSeek: V4 Flash Vision",
        context_length: 131072, supported_parameters: tools,
        pricing: {
          prompt: "0.00000022", completion: "0.00000066", input_cache_read: "0.000000007",
          overrides: [
            { utc_days: ["saturday", "sunday"], prompt: "0.00000022", completion: "0.00000066" },
            {
              utc_days: ["monday"], utc_start: 100, utc_end: 400,
              prompt: "0.00000044", completion: "0.00000132",
            },
          ],
        },
      },
      {
        id: "anthropic/flat-rate", name: "Flat Rate",
        context_length: 200000, supported_parameters: tools,
        pricing: { prompt: "0.000001", completion: "0.000005" },
      },
    ],
  };

  const priceOf = async (id: string) =>
    (await catalogue(serving(body).impl)).find((m) => m.id === id)!.price;

  it("carries the tiers, cheapest first", async () => {
    // 2.67x the headline rate above 128k, which is an ordinary size for a
    // reviewer sent to read a whole branch - and the rate Bench used to quote
    // it at and record against it was the headline one.
    // Written as the scaling the parser performs rather than as the tidy
    // decimal it looks like, because 0.000000104 per token is not exactly
    // $0.104 per million in binary floating point. That is true of the
    // headline rates too and always has been; a price is compared and summed,
    // never matched against a literal outside these tests.
    expect(await priceOf("qwen/qwen3-coder-flash")).toEqual({
      fresh: 0.195, cacheWrite: 0.24375, cacheRead: 0.039, out: 0.975,
      tiers: [
        { fromPromptTokens: 32_000, fresh: 0.325, cacheWrite: 0.40625, cacheRead: 0.065, out: 1.625 },
        {
          fromPromptTokens: 128_000, fresh: 0.52, cacheWrite: 0.65,
          cacheRead: 0.000000104 * 1_000_000, out: 2.6,
        },
      ],
    });
  });

  it("sorts the tiers rather than trusting the order they arrived in", async () => {
    const jumbled = structuredClone(body);
    jumbled.data[0].pricing.overrides!.reverse();
    const price = (await catalogue(serving(jumbled).impl)).find((m) => m.id.startsWith("qwen"))!.price;

    expect(price.tiers!.map((t) => t.fromPromptTokens)).toEqual([32_000, 128_000]);
  });

  it("keeps a base rate the tier did not restate", async () => {
    // Silence in an override means unchanged, not unquoted. Reading it as
    // unquoted would drop cache-write to null, and shared/cost.ts falls back
    // from a null cache-write to the fresh rate - charging ten times over for
    // cached input on every prompt above the threshold.
    const price = await priceOf("google/gemini-3.1-pro-preview");

    expect(price.tiers).toEqual([
      {
        fromPromptTokens: 200_000, fresh: 4, cacheWrite: 0.375,
        cacheRead: 0.0000004 * 1_000_000, out: 18,
      },
    ]);
    // The one that matters: cache-write came through the tier untouched, at
    // the base rate, rather than as a null that would have fallen back to the
    // $4 fresh rate downstream.
    expect(price.tiers![0].cacheWrite).toBe(price.cacheWrite);
  });

  it("ignores an override that prices by the clock rather than by size", async () => {
    // A rate that halves at 4am UTC is not something a picker can quote a
    // developer this afternoon, and there is no honest single number for it.
    // Left on the base rate, which is at least a rate the model does charge.
    const price = await priceOf("deepseek/deepseek-v4-flash-vision-exp");

    expect(price).toEqual({ fresh: 0.22, cacheWrite: null, cacheRead: 0.007, out: 0.66 });
    expect(price).not.toHaveProperty("tiers");
  });

  it("leaves the tiers off entirely for a model that has none", async () => {
    // 359 of the 417. A price parsed today has to be the same object a price
    // parsed before tiers existed was, and compare equal to one.
    const price = await priceOf("anthropic/flat-rate");

    expect(price).toEqual({ fresh: 1, cacheWrite: null, cacheRead: null, out: 5 });
    expect(Object.keys(price)).toEqual(["fresh", "cacheWrite", "cacheRead", "out"]);
  });
});

/**
 * What a request actually cost, rather than what Bench guessed it would.
 *
 * Measured against the account's real charges over 500 requests today: $7.02
 * estimated, $10.24 billed, wrong by 1.46x. The cause is not a stale figure -
 * OpenRouter's catalogue quotes one provider's price and bills at whichever
 * provider actually served the request, decided per request after the fact. No
 * price table can be made right, so the settled figure is fetched instead.
 */
describe("the true cost of a generation", () => {
  /** A fetch that answers the generation route with each body in turn. */
  function settling(...answers: Array<{ body?: unknown; status?: number }>) {
    const seen: Array<{ url: string; auth: string | null }> = [];
    const impl = (async (url: string, init?: RequestInit) => {
      seen.push({ url: String(url), auth: new Headers(init?.headers).get("authorization") });
      const answer = answers[Math.min(seen.length - 1, answers.length - 1)]!;
      return new Response(JSON.stringify(answer.body ?? {}), { status: answer.status ?? 200 });
    }) as unknown as typeof fetch;
    return { impl, seen };
  }

  /** The live shape, as the service serves it. */
  const settled = (cost: number) => ({
    body: {
      data: {
        total_cost: cost, native_tokens_prompt: 1_200, native_tokens_cached: 900,
        native_tokens_completion: 40, provider_name: "Fireworks", model: "deepseek/deepseek-v4-pro",
      },
    },
  });

  it("reads the settled cost off the generation, as that key", async () => {
    const { impl, seen } = settling(settled(2.023e-6));

    expect(await settledCost("gen-1730-abc", "sk-or-v1-abc", impl)).toBe(2.023e-6);
    expect(seen[0].url).toBe(`${BASE_URL}/generation?id=gen-1730-abc`);
    expect(seen[0].auth).toBe("Bearer sk-or-v1-abc");
  });

  it("escapes an id rather than pasting it into the query", async () => {
    const { impl, seen } = settling(settled(1e-6));

    await settledCost("gen/one&two", "k", impl);
    expect(seen[0].url).toBe(`${BASE_URL}/generation?id=gen%2Fone%26two`);
  });

  it("says nothing at all when OpenRouter will not answer", async () => {
    // Never a guess. A cost this is not certain of is worse than no cost,
    // because the whole point is to stop presenting an estimate as settled.
    expect(await settledCost("gen-1", "k", settling({ status: 500 }).impl)).toBeNull();
    expect(await settledCost("gen-1", "k", settling({ status: 401 }).impl)).toBeNull();
    expect(await settledCost("gen-1", "k", settling({ status: 429 }).impl)).toBeNull();
  });

  it("says nothing when the body is not the shape it promised", async () => {
    // A proxy's login page, or a shape that has moved. Reading zero out of
    // either would report the turn as free.
    const shapes = [
      {},
      { data: {} },
      { data: { total_cost: null } },
      { data: { total_cost: "2.023e-06" } },
      { data: { total_cost: Number.NaN } },
      { data: { total_cost: -1 } },
    ];

    for (const body of shapes) {
      expect(await settledCost("gen-1", "k", settling({ body }).impl)).toBeNull();
    }
  });

  it("says nothing when there was no answer at all", async () => {
    const down = (async () => { throw new Error("offline"); }) as unknown as typeof fetch;

    expect(await settledCost("gen-1", "k", down)).toBeNull();
  });

  it("asks a second time when the record is not written yet", async () => {
    // The generation record lands a moment after the response finishes
    // streaming, so a turn that prices itself the instant it ends can beat
    // OpenRouter to its own bookkeeping.
    const { impl, seen } = settling({ status: 404 }, settled(4.4e-6));

    expect(await settledCost("gen-1", "k", impl)).toBe(4.4e-6);
    expect(seen).toHaveLength(2);
  });

  it("gives up after that one retry", async () => {
    // The same 404 is what a genuinely unknown id returns - the live service
    // answers "Generation <id> not found" with a 404 for both - and there is
    // no telling those apart from here. Asking forever would mean a mistyped
    // id costing a delay on every turn for ever.
    const { impl, seen } = settling({ status: 404 });

    expect(await settledCost("gen-1", "k", impl)).toBeNull();
    expect(seen).toHaveLength(2);
  });

  it("does not retry a refusal, which will say the same thing twice", async () => {
    const { impl, seen } = settling({ status: 403 });

    expect(await settledCost("gen-1", "k", impl)).toBeNull();
    expect(seen).toHaveLength(1);
  });
});

/**
 * Adding a turn up.
 *
 * A turn is many requests - a specialist re-sends its conversation on every
 * tool call - so the total is a sum over a list of ids, and a sum with a gap
 * in it looks exactly like a sum without one.
 */
describe("what a whole turn really cost", () => {
  /** A fetch that prices some ids and refuses others. */
  function pricing(costs: Record<string, number | null>) {
    let live = 0;
    let peak = 0;
    const impl = (async (url: string) => {
      live += 1;
      peak = Math.max(peak, live);
      await new Promise((wake) => setTimeout(wake, 1));
      live -= 1;

      const id = decodeURIComponent(String(url).split("id=")[1] ?? "");
      const cost = costs[id];
      if (cost === undefined || cost === null) return new Response("{}", { status: 500 });
      return new Response(JSON.stringify({ data: { total_cost: cost } }), { status: 200 });
    }) as unknown as typeof fetch;
    return { impl, peak: () => peak };
  }

  it("adds up every id and says none were missing", async () => {
    const { impl } = pricing({ a: 1e-6, b: 2e-6, c: 3e-6 });

    const total = await settledCostOfTurn(["a", "b", "c"], "k", impl);

    expect(total.dollars).toBeCloseTo(6e-6, 12);
    expect(total).toMatchObject({ priced: 3, unpriced: 0 });
  });

  it("counts what it could not price rather than hiding it in the total", async () => {
    // The failure this whole change exists to remove. A partial sum presented
    // as a total is the estimate's mistake made harder to spot, so the count
    // of what is missing travels with the money.
    const { impl } = pricing({ a: 1e-6, b: null, c: 3e-6 });

    const total = await settledCostOfTurn(["a", "b", "c"], "k", impl);

    expect(total.dollars).toBeCloseTo(4e-6, 12);
    expect(total).toMatchObject({ priced: 2, unpriced: 1 });
  });

  it("keeps going after a failure rather than abandoning the total", async () => {
    // One 404 in a turn of thirty should cost that request's cost and nothing
    // else.
    const { impl } = pricing({ b: 5e-6 });

    expect(await settledCostOfTurn(["a", "b", "c"], "k", impl))
      .toMatchObject({ priced: 1, unpriced: 2 });
  });

  it("reports nothing priced when the key is refused outright", async () => {
    // Zero dollars and three unpriced, which is not the same as a free turn -
    // and the only thing telling them apart is the second number.
    const { impl } = pricing({});

    expect(await settledCostOfTurn(["a", "b", "c"], "k", impl))
      .toEqual({ dollars: 0, priced: 0, unpriced: 3 });
  });

  it("is nothing at all for a turn with no ids, without asking anybody", async () => {
    let asked = 0;
    const impl = (async () => { asked += 1; return new Response("{}"); }) as unknown as typeof fetch;

    expect(await settledCostOfTurn([], "k", impl)).toEqual({ dollars: 0, priced: 0, unpriced: 0 });
    expect(asked).toBe(0);
  });

  it("keeps a lid on how many it asks at once", async () => {
    // A long turn can carry dozens of ids. Firing them all at once is a burst
    // of forty-odd requests for one turn ending, which is how a rate limit
    // turns a priced turn into an unpriced one.
    const ids = Array.from({ length: 40 }, (_, i) => `gen-${i}`);
    const { impl, peak } = pricing(Object.fromEntries(ids.map((id) => [id, 1e-6])));

    const total = await settledCostOfTurn(ids, "k", impl);

    expect(total.priced).toBe(40);
    expect(peak()).toBeLessThanOrEqual(6);
    // And genuinely in parallel - a serial loop would put a visible pause on
    // the end of every turn.
    expect(peak()).toBeGreaterThan(1);
  });
});

/**
 * What the key has spent, which is the other half of the question the meter
 * beside the model name is asking.
 *
 * A specialist on OpenRouter never touches the Anthropic subscription, so the
 * meter that reports that subscription is answering about the wrong account.
 * This is the account it is actually billed to.
 */
describe("what an OpenRouter key has spent", () => {
  /**
   * A fetch that answers each of the two credit routes with its own body, and
   * records what it was asked. `null` for either is a route that is down.
   */
  function account(bodies: { key?: unknown; credits?: unknown }) {
    const seen: string[] = [];
    const impl = (async (url: string) => {
      seen.push(String(url));
      const body = String(url).endsWith("/credits") ? bodies.credits : bodies.key;
      if (body === undefined) return new Response("no", { status: 500 });
      return new Response(JSON.stringify(body), { status: 200 });
    }) as unknown as typeof fetch;
    return { impl, seen };
  }

  it("reads the spend and the ceiling off the key itself", async () => {
    const { impl, seen } = serving({ data: { usage: 12.4, limit: 50 } });

    expect(await credit("sk-or-v1-abc", impl)).toEqual({
      available: true, spent: 12.4, limit: 50, balance: null,
    });
    expect(seen[0].url).toBe(`${BASE_URL}/key`);
    expect(seen[0].auth).toBe("Bearer sk-or-v1-abc");
  });

  it("carries a key with no ceiling as having none", async () => {
    // Pay-as-you-go. OpenRouter says null, and null is the answer - not zero,
    // which would read as a key with nothing left.
    const { impl } = serving({ data: { usage: 3, limit: null } });

    expect(await credit("sk-or-v1-abc", impl)).toEqual({
      available: true, spent: 3, limit: null, balance: null,
    });
  });

  it("takes a missing spend as nothing spent", async () => {
    // A key that has never been used may come back without the field.
    const { impl } = serving({ data: { limit: 20 } });

    expect(await credit("sk-or-v1-abc", impl)).toEqual({
      available: true, spent: 0, limit: 20, balance: null,
    });
  });

  it("asks the credits route for what the account has left", async () => {
    // The shape is the live service's, checked against it: two accumulators,
    // and what is left is one subtracted from the other.
    const { impl, seen } = account({
      key: { data: { usage: 48.99, limit: null } },
      credits: { data: { total_credits: 50, total_usage: 48.987305431 } },
    });

    expect(await credit("sk-or-v1-abc", impl)).toEqual({
      available: true,
      spent: 48.99,
      limit: null,
      balance: { purchased: 50, remaining: 50 - 48.987305431 },
    });
    expect(seen).toEqual([`${BASE_URL}/key`, `${BASE_URL}/credits`]);
  });

  it("still reports the spend when only the credits route is down", async () => {
    // Two missing numbers instead of one would be a poor trade. The key
    // answered for itself, and what it said is still true.
    const { impl } = account({ key: { data: { usage: 12.4, limit: 50 } } });

    expect(await credit("sk-or-v1-abc", impl)).toEqual({
      available: true, spent: 12.4, limit: 50, balance: null,
    });
  });

  it("takes half a subtraction as no balance at all", async () => {
    // Defaulting the missing half to zero would invent the one number the
    // meter exists to report.
    const { impl } = account({
      key: { data: { usage: 12.4, limit: 50 } },
      credits: { data: { total_credits: 50 } },
    });

    expect(await credit("sk-or-v1-abc", impl)).toMatchObject({ balance: null });
  });

  it("does not ask about the balance when the key itself did not answer", async () => {
    const { impl, seen } = account({ credits: { data: { total_credits: 50, total_usage: 1 } } });

    expect(await credit("sk-or-v1-abc", impl)).toEqual({ available: false, reason: "unreachable" });
    expect(seen).toEqual([`${BASE_URL}/key`]);
  });

  it("says a turned-away key was turned away", async () => {
    const { impl } = serving({ error: "no" }, 401);

    expect(await credit("sk-or-v1-abc", impl)).toEqual({ available: false, reason: "refused" });
  });

  it("says nothing about the key when OpenRouter could not be reached", async () => {
    const impl = (async () => { throw new Error("offline"); }) as unknown as typeof fetch;

    expect(await credit("sk-or-v1-abc", impl)).toEqual({ available: false, reason: "unreachable" });
  });

  it("treats an answer it cannot read as not having reached anything", async () => {
    // A proxy's login page, a 200 that is not the shape promised. Reporting
    // zero spent from that would be reporting a number nobody said.
    const { impl } = serving({ nothing: true });

    expect(await credit("sk-or-v1-abc", impl)).toEqual({ available: false, reason: "unreachable" });
  });
});

/**
 * Where the meter gets its number.
 *
 * Resolved per request rather than at startup, the same as the Anthropic
 * usage source: a developer can save a key or drop it while the daemon runs,
 * and each of those should change what the meter says without a restart.
 */
describe("the credit the meter reads", () => {
  /**
   * Counts readings rather than requests. One reading is two routes now -
   * the key and the account's balance - and what these tests are about is how
   * often the meter goes and asks at all.
   */
  function counting(body: unknown, status = 200) {
    let calls = 0;
    const impl = (async (url: string) => {
      if (String(url).endsWith("/key")) calls += 1;
      return new Response(JSON.stringify(body), { status });
    }) as unknown as typeof fetch;
    return { impl, calls: () => calls };
  }

  it("is nothing to report while no key is held", async () => {
    // Not a failure, and not worth drawing an icon for.
    const { impl, calls } = counting({ data: { usage: 1, limit: 2 } });
    const source = creditSource({ key: () => null, fetchImpl: impl });

    expect(await source()).toEqual({ available: false, reason: "none" });
    expect(calls()).toBe(0);
  });

  it("asks with whatever key is held at the time", async () => {
    const { impl } = counting({ data: { usage: 12.4, limit: 50 } });
    const source = creditSource({ key: () => "sk-or-v1-abc", fetchImpl: impl });

    expect(await source()).toEqual({ available: true, spent: 12.4, limit: 50, balance: null });
  });

  it("holds an answer rather than asking on every hover", async () => {
    let at = 0;
    const { impl, calls } = counting({ data: { usage: 12.4, limit: 50 } });
    const source = creditSource({ key: () => "sk-or-v1-abc", fetchImpl: impl, now: () => at });

    await source();
    at = 30_000;
    await source();

    expect(calls()).toBe(1);
  });

  it("asks again once the answer is stale", async () => {
    let at = 0;
    const { impl, calls } = counting({ data: { usage: 12.4, limit: 50 } });
    const source = creditSource({ key: () => "sk-or-v1-abc", fetchImpl: impl, now: () => at });

    await source();
    at = 61_000;
    await source();

    expect(calls()).toBe(2);
  });

  it("asks again the moment the key changes, however fresh the last answer", async () => {
    let key = "sk-or-v1-abc";
    const { impl, calls } = counting({ data: { usage: 12.4, limit: 50 } });
    const source = creditSource({ key: () => key, fetchImpl: impl, now: () => 0 });

    await source();
    key = "sk-or-v1-def";
    await source();

    expect(calls()).toBe(2);
  });

  it("does not hold on to a failure", async () => {
    // A failure kept for a minute is a key that stays broken for a minute
    // after it was fixed.
    const { impl, calls } = counting({ error: "no" }, 401);
    const source = creditSource({ key: () => "sk-or-v1-abc", fetchImpl: impl, now: () => 0 });

    await source();
    await source();

    expect(calls()).toBe(2);
  });
});
