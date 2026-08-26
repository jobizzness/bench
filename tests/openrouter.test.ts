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
        pricing: { prompt: "0.0000012", completion: "0.00001" },
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
      dollarsPerMillion: 1.875,
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
    expect(models.find((m) => m.id === "openrouter/auto")!.dollarsPerMillion).toBe(null);
    expect(models.find((m) => m.id === "weird/no-context")!.dollarsPerMillion).toBe(0);
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
 * What the key has spent, which is the other half of the question the meter
 * beside the model name is asking.
 *
 * A specialist on OpenRouter never touches the Anthropic subscription, so the
 * meter that reports that subscription is answering about the wrong account.
 * This is the account it is actually billed to.
 */
describe("what an OpenRouter key has spent", () => {
  it("reads the spend and the ceiling off the key itself", async () => {
    const { impl, seen } = serving({ data: { usage: 12.4, limit: 50 } });

    expect(await credit("sk-or-v1-abc", impl)).toEqual({ available: true, spent: 12.4, limit: 50 });
    expect(seen[0].url).toBe(`${BASE_URL}/key`);
    expect(seen[0].auth).toBe("Bearer sk-or-v1-abc");
  });

  it("carries a key with no ceiling as having none", async () => {
    // Pay-as-you-go. OpenRouter says null, and null is the answer - not zero,
    // which would read as a key with nothing left.
    const { impl } = serving({ data: { usage: 3, limit: null } });

    expect(await credit("sk-or-v1-abc", impl)).toEqual({ available: true, spent: 3, limit: null });
  });

  it("takes a missing spend as nothing spent", async () => {
    // A key that has never been used may come back without the field.
    const { impl } = serving({ data: { limit: 20 } });

    expect(await credit("sk-or-v1-abc", impl)).toEqual({ available: true, spent: 0, limit: 20 });
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
  function counting(body: unknown, status = 200) {
    let calls = 0;
    const impl = (async () => {
      calls += 1;
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

    expect(await source()).toEqual({ available: true, spent: 12.4, limit: 50 });
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
