import { describe, it, expect, vi, afterEach } from "vitest";
import { exchangeRefreshToken, RefreshRejected, Refresher } from "../src/daemon/remote/token-refresh.js";

const OK_BODY = { id_token: "id-1", refresh_token: "rt-1", expires_in: "3600", user_id: "u1" };

function fetchAnswering(status: number, body: unknown): typeof fetch {
  return (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
}

describe("exchanging a refresh token for an ID token", () => {
  it("reads the token, its expiry and the uid out of a successful exchange", async () => {
    const exchanged = await exchangeRefreshToken("key", "rt-0", fetchAnswering(200, OK_BODY));
    expect(exchanged.idToken).toBe("id-1");
    expect(exchanged.refreshToken).toBe("rt-1");
    expect(exchanged.uid).toBe("u1");
    expect(exchanged.expiresAt).toBeGreaterThan(Date.now());
    expect(exchanged.expiresAt).toBeLessThanOrEqual(Date.now() + 3600 * 1000 + 1000);
  });

  it("asks securetoken.googleapis.com with the API key and the refresh token", async () => {
    let seenUrl = "";
    let seenBody = "";
    const spy = (async (url: string, init: RequestInit) => {
      seenUrl = url;
      seenBody = String(init.body);
      return new Response(JSON.stringify(OK_BODY), { status: 200 });
    }) as unknown as typeof fetch;

    await exchangeRefreshToken("my-api-key", "my-refresh-token", spy);

    expect(seenUrl).toContain("securetoken.googleapis.com/v1/token");
    expect(seenUrl).toContain("key=my-api-key");
    expect(seenBody).toContain("grant_type=refresh_token");
    expect(seenBody).toContain("refresh_token=my-refresh-token");
  });

  it.each([400, 401, 403])("treats a %i as RefreshRejected - the token itself is dead", async (status) => {
    await expect(
      exchangeRefreshToken("key", "dead", fetchAnswering(status, { error: { message: "TOKEN_EXPIRED" } })),
    ).rejects.toThrow(RefreshRejected);
  });

  it.each([429, 500, 502, 503])(
    "does not treat a %i as a rejection - it says nothing about the token, only that Google is having a bad day",
    async (status) => {
      let caught: unknown = null;
      try {
        await exchangeRefreshToken("key", "rt", fetchAnswering(status, { error: { message: "backend error" } }));
      } catch (error) {
        caught = error;
      }
      expect(caught).not.toBeNull();
      expect(caught).not.toBeInstanceOf(RefreshRejected);
    },
  );

  it("does not call a network failure a rejection - it says nothing about the token", async () => {
    const offline = (async () => { throw new Error("getaddrinfo ENOTFOUND"); }) as unknown as typeof fetch;
    let caught: unknown = null;
    try {
      await exchangeRefreshToken("key", "rt", offline);
    } catch (error) {
      caught = error;
    }
    expect(caught).not.toBeNull();
    expect(caught).not.toBeInstanceOf(RefreshRejected);
  });
});

describe("Refresher", () => {
  afterEach(() => { vi.useRealTimers(); });

  it("holds the exchanged token and its expiry after starting", async () => {
    const refresher = new Refresher({ apiKey: "key", fetchImpl: fetchAnswering(200, OK_BODY), onRotated: () => {}, onRejected: () => {} });
    await refresher.start("rt-0");
    expect(refresher.idToken()).toBe("id-1");
    expect(refresher.expiresAt()).not.toBeNull();
  });

  it("refreshes before the hour is out rather than waiting for expiry", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return new Response(JSON.stringify({ ...OK_BODY, id_token: `id-${calls}` }), { status: 200 });
    }) as unknown as typeof fetch;

    const refresher = new Refresher({ apiKey: "key", fetchImpl, onRotated: () => {}, onRejected: () => {} });
    await refresher.start("rt-0");
    expect(calls).toBe(1);

    // The token is good for an hour; refreshing five minutes early means the
    // scheduled call fires at 55 minutes, not 60.
    await vi.advanceTimersByTimeAsync(55 * 60 * 1000);
    expect(calls).toBe(2);
    expect(refresher.idToken()).toBe("id-2");
  });

  it("persists a rotated refresh token, since the old one may already be dead", async () => {
    const rotated: string[] = [];
    const fetchImpl = fetchAnswering(200, { ...OK_BODY, refresh_token: "rt-rotated" });
    const refresher = new Refresher({
      apiKey: "key", fetchImpl,
      onRotated: (rt) => rotated.push(rt),
      onRejected: () => {},
    });
    await refresher.start("rt-0");
    expect(rotated).toEqual(["rt-rotated"]);
  });

  it("does not call onRotated when the server hands back the same token", async () => {
    const rotated: string[] = [];
    const refresher = new Refresher({
      apiKey: "key", fetchImpl: fetchAnswering(200, OK_BODY),
      onRotated: (rt) => rotated.push(rt),
      onRejected: () => {},
    });
    await refresher.start("rt-1"); // OK_BODY's refresh_token is also "rt-1"
    expect(rotated).toEqual([]);
  });

  it("surfaces a revoked token through onRejected instead of retrying forever", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      if (calls === 1) return new Response(JSON.stringify(OK_BODY), { status: 200 });
      return new Response(JSON.stringify({ error: { message: "TOKEN_EXPIRED" } }), { status: 400 });
    }) as unknown as typeof fetch;

    let rejected: unknown = null;
    const refresher = new Refresher({
      apiKey: "key", fetchImpl,
      onRotated: () => {},
      onRejected: (error) => { rejected = error; },
    });
    await refresher.start("rt-0");
    await vi.advanceTimersByTimeAsync(55 * 60 * 1000);

    expect(rejected).toBeInstanceOf(RefreshRejected);
    expect(refresher.idToken()).toBeNull();

    // "Not a crash loop": no further exchange is scheduled after a rejection.
    const callsAfterRejection = calls;
    await vi.advanceTimersByTimeAsync(6 * 60 * 60 * 1000);
    expect(calls).toBe(callsAfterRejection);
  });

  it("retries a transient 503 on the MIN_DELAY_MS floor and recovers, without ever calling onRejected", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      // The scheduled refresh at 55 minutes hits an outage twice before
      // Google recovers on the third try.
      if (calls >= 2 && calls <= 3) {
        return new Response(JSON.stringify({ error: { message: "backend error" } }), { status: 503 });
      }
      return new Response(JSON.stringify({ ...OK_BODY, id_token: `id-${calls}` }), { status: 200 });
    }) as unknown as typeof fetch;

    let rejected: unknown = null;
    const refresher = new Refresher({
      apiKey: "key", fetchImpl,
      onRotated: () => {},
      onRejected: (error) => { rejected = error; },
    });
    await refresher.start("rt-0");
    expect(calls).toBe(1);

    await vi.advanceTimersByTimeAsync(55 * 60 * 1000); // the scheduled refresh: 503
    expect(calls).toBe(2);
    // Still holding the previous (still valid) token - an outage must not
    // clear what is already good.
    expect(refresher.idToken()).toBe("id-1");
    expect(rejected).toBeNull();

    await vi.advanceTimersByTimeAsync(10_000); // MIN_DELAY_MS retry: 503 again
    expect(calls).toBe(3);
    expect(rejected).toBeNull();

    await vi.advanceTimersByTimeAsync(10_000); // MIN_DELAY_MS retry: recovers
    expect(calls).toBe(4);
    expect(refresher.idToken()).toBe("id-4");
    expect(rejected).toBeNull();
  });

  it("stop() clears the token and cancels the pending refresh", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const fetchImpl = (async () => { calls += 1; return new Response(JSON.stringify(OK_BODY), { status: 200 }); }) as unknown as typeof fetch;
    const refresher = new Refresher({ apiKey: "key", fetchImpl, onRotated: () => {}, onRejected: () => {} });
    await refresher.start("rt-0");

    refresher.stop();
    expect(refresher.idToken()).toBeNull();

    await vi.advanceTimersByTimeAsync(6 * 60 * 60 * 1000);
    expect(calls).toBe(1);
  });
});
