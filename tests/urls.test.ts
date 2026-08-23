import { describe, it, expect } from "vitest";
import { cockpitOrigins, cockpitUrls, isLoopback } from "../src/daemon/urls.js";

const interfaces = () => ({
  lo: [{ family: "IPv4", address: "127.0.0.1", internal: true }],
  eth0: [
    { family: "IPv4", address: "192.168.1.198", internal: false },
    { family: "IPv6", address: "fe80::1", internal: false },
  ],
  docker0: [{ family: "IPv4", address: "172.17.0.1", internal: false }],
});

describe("isLoopback", () => {
  it("knows the addresses that only mean something here", () => {
    expect(isLoopback("127.0.0.1")).toBe(true);
    expect(isLoopback("localhost")).toBe(true);
    expect(isLoopback("::1")).toBe(true);
  });

  it("treats a wide bind as not loopback", () => {
    expect(isLoopback("0.0.0.0")).toBe(false);
  });
});

describe("cockpitUrls", () => {
  it("gives one address when bound to loopback", () => {
    expect(cockpitUrls({ host: "127.0.0.1", port: 7420, token: "t", interfaces }))
      .toEqual(["http://127.0.0.1:7420/?token=t"]);
  });

  it("lists the addresses another device can reach when bound wide", () => {
    // "http://0.0.0.0:7420" is not something anyone can type into a phone.
    const urls = cockpitUrls({ host: "0.0.0.0", port: 7420, token: "t", interfaces });
    expect(urls).toContain("http://192.168.1.198:7420/?token=t");
  });

  it("keeps loopback first, since it needs no network at all", () => {
    const urls = cockpitUrls({ host: "0.0.0.0", port: 7420, token: "t", interfaces });
    expect(urls[0]).toBe("http://127.0.0.1:7420/?token=t");
  });

  it("leaves out IPv6 and internal addresses", () => {
    const urls = cockpitUrls({ host: "0.0.0.0", port: 7420, token: "t", interfaces });
    expect(urls.some((u) => u.includes("fe80"))).toBe(false);
    expect(urls.filter((u) => u.includes("127.0.0.1"))).toHaveLength(1);
  });

  it("carries the token, which is the whole of the authentication", () => {
    for (const url of cockpitUrls({ host: "0.0.0.0", port: 7420, token: "secret", interfaces })) {
      expect(url).toContain("token=secret");
    }
  });

  it("still answers with loopback when there is no network to list", () => {
    const urls = cockpitUrls({ host: "0.0.0.0", port: 7420, token: "t", interfaces: () => ({}) });
    expect(urls).toEqual(["http://127.0.0.1:7420/?token=t"]);
  });
});

describe("cockpitOrigins", () => {
  it("is the same set without the token", () => {
    // The settings page is allowed to know where the daemon answers; handing
    // it the key alongside is a different decision.
    expect(cockpitOrigins({ host: "0.0.0.0", port: 7420, interfaces })).toEqual([
      "http://127.0.0.1:7420",
      "http://192.168.1.198:7420",
      "http://172.17.0.1:7420",
    ]);
  });

  it("offers only itself when the daemon is bound to loopback", () => {
    expect(cockpitOrigins({ host: "127.0.0.1", port: 7420, interfaces }))
      .toEqual(["http://127.0.0.1:7420"]);
  });
});
