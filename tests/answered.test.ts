import { describe, it, expect } from "vitest";
import { answeredReportSeq } from "../src/daemon/answered.js";
import type { ThreadEntry } from "../src/shared/types.js";

let seq = 0;
const entry = (kind: string, extra: Record<string, unknown> = {}): ThreadEntry =>
  ({ seq: seq += 1, at: "2026-08-22T00:00:00.000Z", kind, body: "x", ...extra } as ThreadEntry);

describe("answeredReportSeq", () => {
  it("is nothing on an empty thread", () => {
    expect(answeredReportSeq([])).toBeNull();
  });

  it("is nothing while a report is still waiting", () => {
    expect(answeredReportSeq([
      entry("user"),
      entry("report", { reportSeq: 1 }),
    ])).toBeNull();
  });

  it("counts a report as answered once the developer replies to it", () => {
    expect(answeredReportSeq([
      entry("report", { reportSeq: 1 }),
      entry("user"),
    ])).toBe(1);
  });

  it("goes back to waiting when a newer report arrives", () => {
    // Answering report 1 must not silence report 2.
    expect(answeredReportSeq([
      entry("report", { reportSeq: 1 }),
      entry("user"),
      entry("report", { reportSeq: 2 }),
    ])).toBe(1);
  });

  it("follows the developer through several rounds", () => {
    expect(answeredReportSeq([
      entry("report", { reportSeq: 1 }),
      entry("user"),
      entry("report", { reportSeq: 2 }),
      entry("reply"),
      entry("user"),
    ])).toBe(2);
  });

  it("ignores the specialist's own replies", () => {
    // Only the developer answers a decision.
    expect(answeredReportSeq([
      entry("report", { reportSeq: 1 }),
      entry("reply"),
    ])).toBeNull();
  });
});
