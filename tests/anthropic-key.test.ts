import { describe, it, expect } from "vitest";
import { keyHint, checkKey, isUsageLimitError, limitResetsAt } from "../src/daemon/anthropic-key.js";

describe("what the cockpit is allowed to show of a key", () => {
  it("shows the last four characters and nothing else", () => {
    expect(keyHint("sk-ant-api03-secretsecret4f2a")).toBe("…4f2a");
  });

  it("shows nothing of a key too short to have a tail", () => {
    // A key this short is never a real one, and half of three characters is
    // still most of it.
    expect(keyHint("abc")).toBe("…");
  });
});

describe("checking a key before it is kept", () => {
  const answer = (status: number) => async () => new Response("", { status });

  it("accepts a key the API answers for", async () => {
    expect(await checkKey("sk-ant-good", answer(200) as unknown as typeof fetch)).toBe("ok");
  });

  it("asks the API as that key, in the version it understands", async () => {
    // The whole point of the check is that the API sees this key. Asking as
    // anyone else would accept a typo.
    let sent: Headers | undefined;
    const spy = (async (_url: string, init: RequestInit) => {
      sent = new Headers(init.headers);
      return new Response("", { status: 200 });
    }) as unknown as typeof fetch;

    await checkKey("sk-ant-good", spy);

    expect(sent?.get("x-api-key")).toBe("sk-ant-good");
    expect(sent?.get("anthropic-version")).toBe("2023-06-01");
  });

  it("refuses a key the API turns away", async () => {
    expect(await checkKey("sk-ant-bad", answer(401) as unknown as typeof fetch)).toBe("refused");
  });

  it("refuses a key the API has no permission for", async () => {
    expect(await checkKey("sk-ant-bad", answer(403) as unknown as typeof fetch)).toBe("refused");
  });

  it("cannot vouch for a key when the API cannot be reached", async () => {
    // An offline machine is not a wrong key, and saying so would lock a
    // developer out of storing one.
    const offline = (async () => { throw new Error("getaddrinfo ENOTFOUND"); }) as unknown as typeof fetch;

    expect(await checkKey("sk-ant-unknown", offline)).toBe("unreachable");
  });

  it("cannot vouch for a key when the API is having a bad day", async () => {
    expect(await checkKey("sk-ant-unknown", answer(500) as unknown as typeof fetch)).toBe("unreachable");
  });
});

describe("recognising a credential that cannot serve another turn", () => {
  it("recognises provider limit and billing failures", () => {
    expect(isUsageLimitError("HTTP 429 rate_limit_error")).toBe(true);
    expect(isUsageLimitError("Credit balance is too low")).toBe(true);
    expect(isUsageLimitError("usage limit reached")).toBe(true);
  });

  it("recognises the CLI's own subscription-limit sentences", () => {
    // What a specialist on a setup-token actually says when its window fills.
    // None of these carry "usage limit" or "429", so the key in use was never
    // rotated off - the turn just ended on the sentence.
    expect(isUsageLimitError("success You've hit your session limit · resets 8:30pm (Africa/Banjul)")).toBe(true);
    expect(isUsageLimitError("You’ve hit your weekly limit · resets Sep 20, 10pm")).toBe(true);
    expect(isUsageLimitError("You've reached your Fable limit.")).toBe(true);
    expect(isUsageLimitError("You're out of extra usage")).toBe(true);
    expect(isUsageLimitError("You're out of usage credits")).toBe(true);
  });

  it("does not rotate credentials for an unrelated process failure", () => {
    expect(isUsageLimitError("worktree does not exist")).toBe(false);
  });
});

describe("when a spent setup-token comes back", () => {
  // 20:25 UTC - the moment the session limit was actually hit on this bench.
  const now = Date.parse("2026-09-15T20:25:00Z");

  it("reads a later time today, in the zone the CLI named", () => {
    expect(limitResetsAt("You've hit your session limit · resets 8:30pm (Africa/Banjul)", now))
      .toBe("2026-09-15T20:30:00.000Z");
  });

  it("reads an hour with no minutes as on the hour", () => {
    expect(limitResetsAt("You've hit your session limit · resets 9pm (America/New_York)", now))
      .toBe("2026-09-16T01:00:00.000Z");
  });

  it("rolls a time already past today over to tomorrow", () => {
    expect(limitResetsAt("You've hit your session limit · resets 4am (Atlantic/Reykjavik)", now))
      .toBe("2026-09-16T04:00:00.000Z");
  });

  it("reads a weekly limit's date as well as its time", () => {
    // Days away, not hours: falling back to the fifteen-minute cooldown here
    // would retry a spent key a few hundred times before it came back.
    expect(limitResetsAt("You've hit your weekly limit · resets Aug 29, 4pm (Africa/Banjul)", Date.parse("2026-08-25T10:00:00Z")))
      .toBe("2026-08-29T16:00:00.000Z");
  });

  it("says nothing rather than guess", () => {
    // Null falls back to the fifteen-minute cooldown, which is what a spent
    // key got before any of this was read.
    expect(limitResetsAt("You're out of extra usage", now)).toBeNull();
    expect(limitResetsAt("You've hit your session limit · resets 8:30pm (Not/AZone)", now)).toBeNull();
  });
});

describe("checking a token minted by `claude setup-token`", () => {
  const OAT = "sk-ant-oat01-abcdefgh1234";

  const spyOn = async (key: string) => {
    let sent: Headers | undefined;
    const spy = (async (_url: string, init: RequestInit) => {
      sent = new Headers(init.headers);
      return new Response("", { status: 200 });
    }) as unknown as typeof fetch;
    await checkKey(key, spy);
    return sent;
  };

  it("presents an oauth token as a bearer token, not as an API key", async () => {
    // The API only reads `x-api-key` as an API key. A setup-token is an
    // OAuth token, and sending it there is a 401 - the same 401 a typo
    // gives, which is why a good token read as a bad one.
    const sent = await spyOn(OAT);

    expect(sent?.get("authorization")).toBe(`Bearer ${OAT}`);
    expect(sent?.has("x-api-key")).toBe(false);
  });

  it("asks in the beta the oauth tokens are answered under", async () => {
    expect((await spyOn(OAT))?.get("anthropic-beta")).toBe("oauth-2025-04-20");
  });

  it("still presents an API key as an API key", async () => {
    const sent = await spyOn("sk-ant-api03-abcdefgh1234");

    expect(sent?.get("x-api-key")).toBe("sk-ant-api03-abcdefgh1234");
    expect(sent?.has("authorization")).toBe(false);
  });
});
