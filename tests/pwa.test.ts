/**
 * @vitest-environment jsdom
 * @vitest-environment-options { "url": "http://localhost/?token=t" }
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { installManifest, manifestHref, registerWorker } from "../src/client/pwa.js";

const link = () => document.querySelector<HTMLLinkElement>('link[rel="manifest"]');

beforeEach(() => { document.head.innerHTML = ""; });

describe("the manifest link", () => {
  it("carries the token, because the browser fetches it without our header", () => {
    installManifest(document, "tok-123");
    expect(link()!.getAttribute("href")).toBe("/manifest.webmanifest?token=tok-123");
  });

  it("escapes a token that would otherwise break the query", () => {
    expect(manifestHref("a b&c")).toBe("/manifest.webmanifest?token=a%20b%26c");
  });

  it("falls back to the plain manifest, which is what hosted copies install", () => {
    // A copy of the cockpit on static hosting has no token until it is told
    // which daemon it belongs to, and it still has to be installable.
    installManifest(document, "");
    expect(link()!.getAttribute("href")).toBe("/manifest.webmanifest");
  });

  it("replaces its link rather than adding a second", () => {
    installManifest(document, "one");
    installManifest(document, "two");
    expect(document.querySelectorAll('link[rel="manifest"]')).toHaveLength(1);
    expect(link()!.getAttribute("href")).toContain("two");
  });
});

describe("registering the worker", () => {
  const secure = (value: boolean) =>
    Object.defineProperty(window, "isSecureContext", { value, configurable: true });

  afterEach(() => {
    secure(false);
    Reflect.deleteProperty(navigator, "serviceWorker");
  });

  it("registers at the root, so /s/<id> is inside its scope", async () => {
    secure(true);
    const register = vi.fn().mockResolvedValue({});
    Object.defineProperty(navigator, "serviceWorker", { value: { register }, configurable: true });

    expect(await registerWorker()).toBe(true);
    expect(register).toHaveBeenCalledWith("/sw.js", { scope: "/" });
  });

  it("does not try on an insecure origin, which is every LAN address", async () => {
    // http://192.168.1.10 is not a secure context, so the phone that most
    // wants this cannot have it. Asking anyway only prints an error.
    secure(false);
    const register = vi.fn();
    Object.defineProperty(navigator, "serviceWorker", { value: { register }, configurable: true });

    expect(await registerWorker()).toBe(false);
    expect(register).not.toHaveBeenCalled();
  });

  it("survives a browser that refuses, since nothing here is load-bearing", async () => {
    secure(true);
    Object.defineProperty(navigator, "serviceWorker", {
      value: { register: vi.fn().mockRejectedValue(new Error("nope")) },
      configurable: true,
    });

    expect(await registerWorker()).toBe(false);
  });
});
