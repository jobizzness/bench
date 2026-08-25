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
