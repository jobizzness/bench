import { describe, it, expect } from "vitest";
import {
  currentEndpoint, parseCockpitLink, reach, savedEndpoint, saveEndpoint, shouldAskForServer, socketUrl,
} from "../src/client/endpoint.js";

/** localStorage without a browser. */
function store(seed: Record<string, string> = {}): Storage {
  const map = new Map(Object.entries(seed));
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => { map.set(k, v); },
    removeItem: (k: string) => { map.delete(k); },
    clear: () => map.clear(),
    key: () => null,
    get length() { return map.size; },
  } as unknown as Storage;
}

describe("reading the link the daemon printed", () => {
  it("takes the address and the token out of one line", () => {
    expect(parseCockpitLink("http://192.168.1.20:7420/?token=abc123")).toEqual({
      origin: "http://192.168.1.20:7420",
      token: "abc123",
    });
  });

  it("forgives the whitespace that comes with a copied line", () => {
    expect(parseCockpitLink("  http://127.0.0.1:7420/?token=abc  ")?.token).toBe("abc");
  });

  it("assumes http for an address typed off another screen", () => {
    expect(parseCockpitLink("192.168.1.20:7420/?token=abc")?.origin).toBe("http://192.168.1.20:7420");
  });

  it("keeps https where it was given, which is what a tunnel needs", () => {
    expect(parseCockpitLink("https://bench.example.ts.net/?token=abc")?.origin)
      .toBe("https://bench.example.ts.net");
  });

  it("refuses a link with no token, which would save a cockpit that 401s", () => {
    expect(parseCockpitLink("http://127.0.0.1:7420/")).toBeNull();
    expect(parseCockpitLink("")).toBeNull();
    expect(parseCockpitLink("not a url at all ///")).toBeNull();
  });
});

describe("which daemon a page is for", () => {
  it("believes the address bar over anything remembered", () => {
    // Opening the link the daemon just printed is how you point the cockpit
    // at a daemon. Preferring last week's would make that impossible.
    const remembered = store({ "bench:endpoint": JSON.stringify({ origin: "http://old", token: "old" }) });
    expect(currentEndpoint({ origin: "http://127.0.0.1:7420", search: "?token=new" }, remembered))
      .toEqual({ origin: "http://127.0.0.1:7420", token: "new" });
  });

  it("falls back to what this browser was told", () => {
    const remembered = store({ "bench:endpoint": JSON.stringify({ origin: "http://desk:7420", token: "t" }) });
    expect(currentEndpoint({ origin: "https://bench.web.app", search: "" }, remembered))
      .toEqual({ origin: "http://desk:7420", token: "t" });
  });

  it("knows nothing on a hosted copy that has never been told", () => {
    expect(currentEndpoint({ origin: "https://bench.web.app", search: "" }, store())).toBeNull();
  });

  it("round-trips what it saved", () => {
    const s = store();
    saveEndpoint({ origin: "http://desk:7420", token: "t" }, s);
    expect(savedEndpoint(s)).toEqual({ origin: "http://desk:7420", token: "t" });
  });

  it("ignores a stored value that is not an endpoint", () => {
    expect(savedEndpoint(store({ "bench:endpoint": "{{{" }))).toBeNull();
    expect(savedEndpoint(store({ "bench:endpoint": '{"origin":5}' }))).toBeNull();
  });
});

describe("the socket address", () => {
  it("follows the scheme, so an https daemon is not asked for a ws socket", () => {
    expect(socketUrl({ origin: "http://desk:7420", token: "a b" }))
      .toBe("ws://desk:7420/events?token=a%20b");
    expect(socketUrl({ origin: "https://bench.example.ts.net", token: "t" }))
      .toBe("wss://bench.example.ts.net/events?token=t");
  });
});

describe("whether a daemon is there", () => {
  const at = (impl: () => Promise<any>) => reach({ origin: "http://desk:7420", token: "t" }, impl as any);

  it("asks with the token, at the daemon's own address", async () => {
    let asked = "";
    let sent = "";
    await reach({ origin: "http://desk:7420", token: "t" }, (async (url: string, init: any) => {
      asked = url;
      sent = init.headers["x-bench-token"];
      return { ok: true, status: 200 };
    }) as any);

    expect(asked).toBe("http://desk:7420/api/addresses");
    expect(sent).toBe("t");
  });

  it("tells a wrong token from a wrong address, which need different fixes", async () => {
    expect(await at(async () => ({ ok: true, status: 200 }))).toBe("ok");
    expect(await at(async () => ({ ok: false, status: 401 }))).toBe("unauthorized");
    expect(await at(async () => ({ ok: false, status: 500 }))).toBe("unreachable");
    expect(await at(async () => { throw new TypeError("failed to fetch"); })).toBe("unreachable");
  });
});

describe("when to interrupt and ask where Bench is", () => {
  const ask = (over: Partial<Parameters<typeof shouldAskForServer>[0]> = {}) =>
    shouldAskForServer({ known: true, live: null, everConnected: false, remote: true, ...over });

  it("asks a page that knows of no daemon at all", () => {
    // A hosted cockpit on its first run knows every screen in Bench and not
    // one thing about which machine it belongs to.
    expect(ask({ known: false })).toBe(true);
  });

  it("waits while the socket is still coming up", () => {
    expect(ask({ live: null })).toBe(false);
  });

  it("asks when an address that was typed in has never answered", () => {
    expect(ask({ live: false })).toBe(true);
  });

  it("stays quiet when a daemon that has answered before goes away", () => {
    // That is a restart, and the banner says so. A dialog asking where Bench
    // is would be asking about the machine it is running on.
    expect(ask({ live: false, everConnected: true })).toBe(false);
  });

  it("stays quiet when the daemon served this very page", () => {
    // Nothing to correct: the address is where the page came from.
    expect(ask({ live: false, remote: false })).toBe(false);
  });
});
