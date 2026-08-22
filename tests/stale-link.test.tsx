/**
 * @vitest-environment jsdom
 * @vitest-environment-options { "url": "http://localhost/?token=stale" }
 */
import { describe, it, expect, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { StaleLink } from "../src/client/components/StaleLink.js";
import { authFetch, linkIsStale } from "../src/client/api.js";

/**
 * The daemon mints a new token when it restarts, which quietly invalidates
 * every bookmark. Without saying so the cockpit just shows an empty roster,
 * and an empty roster looks exactly like having lost every specialist.
 */

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
});

function mount(): HTMLElement {
  host = document.createElement("div");
  document.body.appendChild(host);
  act(() => { root = createRoot(host!); root.render(<StaleLink />); });
  return host;
}

const banner = () => host!.querySelector("#stale");

describe("the stale link banner", () => {
  it("says nothing until something has actually failed", () => {
    mount();
    expect(banner()).toBeNull();
  });

  it("appears when a request comes back unauthorised", async () => {
    mount();
    (globalThis as any).fetch = async () => ({ ok: false, status: 401, json: async () => ({}) });

    await act(async () => { await authFetch("/api/roster"); });

    expect(banner()).not.toBeNull();
    expect(banner()!.getAttribute("role")).toBe("alert");
    expect(banner()!.textContent).toContain("out of date");
  });

  it("stays quiet for a request that merely failed some other way", async () => {
    mount();
    (globalThis as any).fetch = async () => ({ ok: false, status: 404, json: async () => ({}) });

    await act(async () => { await authFetch("/api/sessions/nope/thread"); });

    // A missing session is not a stale link, and saying so would send the
    // developer off to restart a daemon that is running perfectly well.
    expect(banner()).toBeNull();
  });

  it("stays up once it is up", async () => {
    mount();
    act(() => linkIsStale());
    expect(banner()).not.toBeNull();

    (globalThis as any).fetch = async () => ({ ok: true, status: 200, json: async () => ({}) });
    await act(async () => { await authFetch("/api/roster"); });

    // Nothing can un-stale a token, so there is no path back except reloading
    // with the URL the daemon printed.
    expect(banner()).not.toBeNull();
  });

  it("sends the token the link was opened with", async () => {
    let seen: Record<string, string> | undefined;
    (globalThis as any).fetch = async (_url: string, init: RequestInit) => {
      seen = init.headers as Record<string, string>;
      return { ok: true, status: 200, json: async () => ({}) };
    };

    await authFetch("/api/roster");
    expect(seen!["x-bench-token"]).toBe("stale");
  });
});
