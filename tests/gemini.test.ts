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
  RECENT_COSTS,
} from "../src/daemon/gemini.js";

/** A fetch that answers one body, and records what it was asked. */
function serving(body: unknown, status = 200) {
  const seen: Array<{ url: string; auth: string | null }> = [];
  const impl = (async (url: string, init?: RequestInit) => {
    seen.push({ url: String(url), auth: new Headers(init?.headers).get("authorization") });
    return new Response(JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
  return { impl, seen };
}

describe("which models go through Gemini", () => {
  it("is decided by the slash, which every proxied model id has", () => {
    expect(isOpenRouterModel("google/gemini-2.5-flash")).toBe(true);
  });

  it("leaves Anthropic's aliases alone", () => {
    for (const id of ["opus", "sonnet", "fable", "haiku"]) {
      expect(isOpenRouterModel(id)).toBe(false);
    }
  });

  it("reads the vendor off the front, which is how the picker groups", () => {
    expect(vendorOf("google/gemini-2.5-flash")).toBe("google");
  });
});

describe("what a specialist is given", () => {
  it("points the CLI at the local proxy and hands it the key", () => {
    expect(sessionEnv({ key: "sk-or-v1-abc", contextLength: 1_048_576, cockpitUrl: "http://127.0.0.1:7420" })).toEqual({
      ANTHROPIC_BASE_URL: "http://127.0.0.1:7420/api/openrouter",
      ANTHROPIC_API_KEY: "sk-or-v1-abc",
      CLAUDE_CODE_MAX_CONTEXT_TOKENS: "1048576",
    });
  });

  it("gives a base URL the CLI turns into the local proxy's messages route", () => {
    expect(messagesUrl(sessionEnv({ key: "k", cockpitUrl: "http://127.0.0.1:7420" }).ANTHROPIC_BASE_URL))
      .toBe("http://127.0.0.1:7420/api/openrouter/v1/messages");
  });

  it("tells the CLI how much the model actually holds", () => {
    expect(sessionEnv({ key: "k", contextLength: 200_000 }).CLAUDE_CODE_MAX_CONTEXT_TOKENS)
      .toBe("200000");
  });
});

describe("checking a key before it is kept", () => {
  it("asks Gemini, as that key", async () => {
    const { impl, seen } = serving({ data: {} });
    expect(await checkKey("sk-gem-good", impl)).toBe("ok");
    expect(seen[0].url).toBe(`${BASE_URL}/v1/models`);
    expect(seen[0].auth).toBe("Bearer sk-gem-good");
  });

  it("tells a refusal from a machine that is simply offline", async () => {
    const refused = serving({}, 401).impl;
    const broken = serving({}, 503).impl;
    const down = (async () => { throw new Error("dns"); }) as unknown as typeof fetch;

    expect(await checkKey("k", refused)).toBe("refused");
    expect(await checkKey("k", broken)).toBe("unreachable");
    expect(await checkKey("k", down)).toBe("unreachable");
  });
});

describe("the catalogue", () => {
  it("returns static Gemini models with contexts and price structures", async () => {
    const models = await catalogue();
    expect(models.length).toBeGreaterThan(0);
    expect(models[0].id).toBe("google/gemini-3.1-pro-preview");
    expect(models[0].contextLength).toBe(2097152);
  });
});

describe("settled cost of turns", () => {
  it("returns cost stored in-memory during stream translation", async () => {
    RECENT_COSTS.set("gen-test-1", 0.005);
    const cost = await settledCost("gen-test-1", "key");
    expect(cost).toBe(0.005);

    const total = await settledCostOfTurn(["gen-test-1", "gen-unknown"], "key");
    expect(total).toEqual({
      dollars: 0.005,
      priced: 1,
      unpriced: 1,
    });
  });
});
