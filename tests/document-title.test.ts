import { describe, it, expect } from "vitest";
import { benchTitle } from "../src/client/components/useDocumentTitle.js";
import type { RosterRow } from "../src/shared/types.js";

const row = (over: Partial<RosterRow> = {}): RosterRow => ({
  id: "s1", label: "auth", project: "/p", status: "awaiting_decision",
  detail: "ready", latestReportSeq: null, answeredReportSeq: null,
  startedAt: null, tokens: 0, activity: [], ...over,
});

/** A report written and not yet answered: this one wants you. */
const waiting = (over: Partial<RosterRow> = {}) =>
  row({ latestReportSeq: 2, answeredReportSeq: 1, ...over });

describe("benchTitle", () => {
  it("is just the product with nothing open and nothing waiting", () => {
    expect(benchTitle([row()], null)).toBe("Bench");
  });

  it("names the specialist you are looking at", () => {
    // A tab per specialist is the normal way to use this, and "Bench" on all
    // of them is the one name that cannot tell them apart.
    expect(benchTitle([row()], "s1")).toBe("auth · Bench");
  });

  it("counts what wants you, in front, where the strip shows it", () => {
    expect(benchTitle([waiting()], null)).toBe("(1) Bench");
  });

  it("carries both at once", () => {
    expect(benchTitle([waiting()], "s1")).toBe("(1) auth · Bench");
  });

  it("counts every specialist waiting, not just the open one", () => {
    const rows = [waiting(), waiting({ id: "s2", label: "billing" }), row({ id: "s3" })];
    expect(benchTitle(rows, "s1")).toBe("(2) auth · Bench");
  });

  it("does not count one that is still working", () => {
    expect(benchTitle([waiting({ status: "working" })], null)).toBe("Bench");
  });

  it("does not count a decision already answered", () => {
    expect(benchTitle([row({ latestReportSeq: 2, answeredReportSeq: 2 })], null)).toBe("Bench");
  });

  it("falls back to the product when the selection is not on the roster", () => {
    expect(benchTitle([row()], "gone")).toBe("Bench");
  });
});
