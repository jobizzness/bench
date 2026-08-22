import { describe, it, expect } from "vitest";
import { isWaiting } from "../src/client/waiting.js";
import type { RosterRow } from "../src/shared/types.js";

const row = (over: Partial<RosterRow> = {}): RosterRow => ({
  id: "s1", label: "auth", project: "/p", status: "awaiting_decision",
  detail: "waiting on you", latestReportSeq: 1, answeredReportSeq: null,
  startedAt: null, tokens: 0, activity: [], ...over,
});

describe("isWaiting", () => {
  it("is waiting when a report has not been answered", () => {
    expect(isWaiting(row())).toBe(true);
  });

  it("is not waiting once that report has been answered", () => {
    expect(isWaiting(row({ answeredReportSeq: 1 }))).toBe(false);
  });

  it("is waiting again when a newer report arrives", () => {
    expect(isWaiting(row({ latestReportSeq: 2, answeredReportSeq: 1 }))).toBe(true);
  });

  it("is not waiting when the turn only replied", () => {
    // A specialist that answered a question wrote no report, and the roster
    // must not claim a decision is waiting with nothing to read.
    expect(isWaiting(row({ latestReportSeq: null }))).toBe(false);
  });

  it("is not waiting while it is still working", () => {
    expect(isWaiting(row({ status: "working" }))).toBe(false);
  });
});
