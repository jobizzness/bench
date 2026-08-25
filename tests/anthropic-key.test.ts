import { describe, it, expect } from "vitest";
import { keyHint, checkKey } from "../src/daemon/anthropic-key.js";

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
