import { describe, it, expect } from "vitest";
import { isLoopbackOnlyPath, isLoopbackPeer } from "../src/daemon/loopback-only.js";

describe("isLoopbackPeer", () => {
  it("accepts this machine's own addresses, IPv4 mapped into IPv6 included", () => {
    for (const address of ["127.0.0.1", "::1", "::ffff:127.0.0.1"]) {
      expect(isLoopbackPeer(address)).toBe(true);
    }
  });

  it("refuses everything else, and a socket that has no peer at all", () => {
    for (const address of ["192.168.1.20", "::ffff:192.168.1.20", "fe80::1", "0.0.0.0", "localhost", "", undefined]) {
      expect(isLoopbackPeer(address)).toBe(false);
    }
  });
});

describe("isLoopbackOnlyPath", () => {
  it("names the routes that hand out a key", () => {
    expect(isLoopbackOnlyPath("/api/anthropic-keys/active")).toBe(true);
    expect(isLoopbackOnlyPath("/api/anthropic-keys/exhausted")).toBe(true);
  });

  it("reads the path the way the server will, query and dot segments included", () => {
    expect(isLoopbackOnlyPath("/api/anthropic-keys/active?token=x")).toBe(true);
    expect(isLoopbackOnlyPath("/api/anthropic-keys/./active")).toBe(true);
    expect(isLoopbackOnlyPath("/api/x/../anthropic-keys/exhausted")).toBe(true);
    expect(isLoopbackOnlyPath("\\api\\anthropic-keys\\active")).toBe(true);
  });

  it("leaves the states, the pin and everything else to the relay", () => {
    expect(isLoopbackOnlyPath("/api/anthropic-keys")).toBe(false);
    expect(isLoopbackOnlyPath("/api/anthropic-keys/pin")).toBe(false);
    expect(isLoopbackOnlyPath("/api/settings")).toBe(false);
  });
});
