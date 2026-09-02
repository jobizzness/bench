import { describe, it, expect } from "vitest";
import { elapsedSince, formatTokens, ago, relativeTime, hashOf, phoneActivity } from "../src/client/format.js";

const NOW = Date.parse("2026-08-22T12:00:00.000Z");
const at = (secondsAgo: number) => new Date(NOW - secondsAgo * 1000).toISOString();

describe("elapsedSince", () => {
  it("counts seconds under a minute", () => {
    expect(elapsedSince(at(42), NOW)).toBe("42s");
  });

  it("pads the seconds once there are minutes", () => {
    expect(elapsedSince(at(65), NOW)).toBe("1m 05s");
  });

  it("is empty for something unparseable, rather than NaN", () => {
    expect(elapsedSince("not a date", NOW)).toBe("");
  });
});

describe("formatTokens", () => {
  it("is nothing at zero, so the meta line stays short", () => {
    expect(formatTokens(0)).toBeNull();
  });

  it("counts small numbers exactly", () => {
    expect(formatTokens(940)).toBe("940 tokens");
  });

  it("rounds to thousands once it is long", () => {
    expect(formatTokens(4300)).toBe("4.3k tokens");
  });
});

describe("ago", () => {
  it("reads in seconds, then minutes, then hours", () => {
    expect(ago(at(5), NOW)).toBe("5s ago");
    expect(ago(at(300), NOW)).toBe("5m ago");
    expect(ago(at(7200), NOW)).toBe("2h ago");
  });

  it("never goes negative on a clock that disagrees", () => {
    expect(ago(new Date(NOW + 5000).toISOString(), NOW)).toBe("0s ago");
  });
});

describe("phoneActivity", () => {
  it("drops a Bash command entirely - shell syntax is not a phone's business", () => {
    expect(phoneActivity("Bash timeout 600 pnpm deploy:web 2>&1 | tail -4"))
      .toBe("Running a command");
  });

  it("keeps a file tool's already-short target", () => {
    expect(phoneActivity("Edit src/client/styles.css")).toBe("Editing src/client/styles.css");
    expect(phoneActivity("Read src/client/format.ts")).toBe("Reading src/client/format.ts");
  });

  it("puts a generic verb ahead of a target for a tool it does not know, and falls back to the bare name for one with none", () => {
    expect(phoneActivity("Task code-reviewer")).toBe("Using code-reviewer");
    expect(phoneActivity("Skill bench-report")).toBe("Using bench-report");
    expect(phoneActivity("KillShell")).toBe("KillShell");
  });
});

describe("relativeTime", () => {
  it("says just now under a minute", () => {
    expect(relativeTime(at(30), NOW)).toBe("just now");
  });

  it("reaches days", () => {
    expect(relativeTime(at(60 * 60 * 50), NOW)).toBe("2d ago");
  });
});

describe("hashOf", () => {
  it("is stable, so a specialist keeps its own verb", () => {
    expect(hashOf("abc")).toBe(hashOf("abc"));
  });

  it("separates different ids", () => {
    expect(hashOf("abc")).not.toBe(hashOf("abd"));
  });
});
