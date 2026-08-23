/**
 * @vitest-environment jsdom
 * @vitest-environment-options { "url": "http://127.0.0.1:7420/s/abc?token=t" }
 */
import { describe, it, expect } from "vitest";
import { isHere, targetUrl, toOrigin } from "../src/client/server-location.js";

/**
 * Pointing the cockpit somewhere else is a navigation, so the whole of the
 * feature is getting one URL right.
 */

describe("what someone types", () => {
  it("takes a bare host and port, which is what anyone actually types", () => {
    expect(toOrigin("192.168.1.198:7420")).toBe("http://192.168.1.198:7420");
  });

  it("takes a whole URL, and keeps https where it was given", () => {
    expect(toOrigin("https://bench.example.com")).toBe("https://bench.example.com");
    expect(toOrigin("http://127.0.0.1:7420/")).toBe("http://127.0.0.1:7420");
  });

  it("throws away the path, because the path comes from where you are", () => {
    expect(toOrigin("192.168.1.198:7420/s/abc?token=x")).toBe("http://192.168.1.198:7420");
  });

  it("refuses what is not an address rather than navigating nowhere", () => {
    expect(toOrigin("")).toBe("");
    expect(toOrigin("   ")).toBe("");
    expect(toOrigin("http://")).toBe("");
  });
});

describe("where it sends you", () => {
  it("keeps the token, or the new address answers 401 and looks broken", () => {
    expect(targetUrl("http://192.168.1.198:7420", "abc123"))
      .toBe("http://192.168.1.198:7420/?token=abc123");
  });

  it("keeps the specialist you were reading", () => {
    // Switching from a phone should land where you were, not at the roster.
    expect(targetUrl("http://192.168.1.198:7420", "t", "/s/abc"))
      .toBe("http://192.168.1.198:7420/s/abc?token=t");
  });

  it("escapes a token rather than trusting it to be URL-safe", () => {
    expect(targetUrl("http://x:1", "a b&c")).toBe("http://x:1/?token=a%20b%26c");
  });

  it("knows the address it is already at", () => {
    expect(isHere("127.0.0.1:7420")).toBe(true);
    expect(isHere("http://127.0.0.1:7420")).toBe(true);
    expect(isHere("192.168.1.198:7420")).toBe(false);
  });
});
