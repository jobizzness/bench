import { describe, it, expect } from "vitest";
import { isDeadToken, payload, recipients, VIEWER_STALE_MS } from "../functions/src/plan.js";

const now = 10_000_000;
const devices = [{ id: "phone", token: "t-phone" }, { id: "laptop", token: "t-laptop" }];

describe("who a push goes to", () => {
  it("goes to every device when nobody is looking", () => {
    expect(recipients(devices, {}, "s1", now).map((d) => d.id)).toEqual(["phone", "laptop"]);
  });

  it("skips a device that has that very tab open", () => {
    const viewers = { laptop: { at: now - 30_000, watching: "s1" } };
    expect(recipients(devices, viewers, "s1", now).map((d) => d.id)).toEqual(["phone"]);
  });

  it("still notifies a device open on a different tab", () => {
    const viewers = { laptop: { at: now - 30_000, watching: "s2" } };
    expect(recipients(devices, viewers, "s1", now).map((d) => d.id)).toEqual(["phone", "laptop"]);
  });

  it("does not trust a viewer entry that has gone stale - the tab was closed without saying so", () => {
    const viewers = { laptop: { at: now - VIEWER_STALE_MS - 1, watching: "s1" } };
    expect(recipients(devices, viewers, "s1", now).map((d) => d.id)).toEqual(["phone", "laptop"]);
  });
});

describe("what a push says", () => {
  it("carries the words, where a tap goes, and one tag per tab", () => {
    expect(payload({ sessionId: "s1", kind: "needs", title: "designer · realpeep", body: "Wrote a report: X", at: now })).toEqual({
      title: "designer · realpeep", body: "Wrote a report: X", url: "/s/s1", tag: "bench-s1", kind: "needs",
    });
  });

  it("forgets only tokens FCM says are dead", () => {
    expect(isDeadToken("messaging/registration-token-not-registered")).toBe(true);
    expect(isDeadToken("messaging/internal-error")).toBe(false);
  });
});
