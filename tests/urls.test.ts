import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { announceCockpitUrls, cockpitOrigins, cockpitUrls, isLoopback } from "../src/daemon/urls.js";

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

describe("announceCockpitUrls", () => {
  const WARNING =
    "bench: reachable on this network. The token in that URL is the only thing"
    + " standing in front of a shell on this machine.";

  let ifaces: Record<string, Array<{ family: string; address: string; internal: boolean }> | undefined>;
  let lines: string[];

  const start = (host: string) =>
    announceCockpitUrls({
      host,
      port: 7420,
      token: "t",
      interfaces: () => ifaces,
      write: (line) => lines.push(line),
    });

  beforeEach(() => {
    vi.useFakeTimers();
    ifaces = {};
    lines = [];
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("prints loopback only and says nothing about the network when bound to loopback", () => {
    ifaces = interfaces();
    start("127.0.0.1");
    expect(lines).toEqual(["bench: http://127.0.0.1:7420/?token=t"]);
    vi.advanceTimersByTime(10_000);
    expect(lines).toHaveLength(1);
  });

  it("warns immediately when a network address is already up", () => {
    ifaces = interfaces();
    start("0.0.0.0");
    expect(lines).toEqual([
      "bench: http://127.0.0.1:7420/?token=t",
      "bench: http://192.168.1.198:7420/?token=t",
      "bench: http://172.17.0.1:7420/?token=t",
      WARNING,
    ]);
    vi.advanceTimersByTime(10_000);
    expect(lines).toHaveLength(4);
  });

  it("announces the address when the network comes up after listen", () => {
    start("0.0.0.0");
    expect(lines).toEqual([
      "bench: http://127.0.0.1:7420/?token=t",
      "bench: bound to every interface, but no network is up yet - more addresses print as they appear.",
    ]);
    ifaces = { eth0: [{ family: "IPv4", address: "192.168.1.198", internal: false }] };
    vi.advanceTimersByTime(2000);
    expect(lines.slice(2)).toEqual(["bench: http://192.168.1.198:7420/?token=t", WARNING]);
    ifaces = {
      ...ifaces,
      eth1: [{ family: "IPv4", address: "10.0.0.5", internal: false }],
    };
    vi.advanceTimersByTime(10_000);
    expect(lines).toHaveLength(4);
  });

  it("gives up after the deadline", () => {
    start("0.0.0.0");
    vi.advanceTimersByTime(60_000);
    expect(lines.at(-1)).toBe(
      "bench: still no network address after 60s - Settings > Server lists addresses as they appear.",
    );
    vi.advanceTimersByTime(10_000);
    expect(lines.at(-1)).toBe(
      "bench: still no network address after 60s - Settings > Server lists addresses as they appear.",
    );
  });

  it("stop() ends the polling", () => {
    const announcer = start("0.0.0.0");
    announcer.stop();
    ifaces = { eth0: [{ family: "IPv4", address: "192.168.1.198", internal: false }] };
    vi.advanceTimersByTime(5000);
    expect(lines).toHaveLength(2);
  });

  it("never prints the same address twice", () => {
    ifaces = { eth0: [{ family: "IPv4", address: "192.168.1.198", internal: false }] };
    start("0.0.0.0");
    vi.advanceTimersByTime(10_000);
    expect(lines).toHaveLength(3);
  });
});
