import { describe, it, expect } from "vitest";
import { isWaiting, specialistsHere, waitingCount } from "../editor/vscode/src/roster.js";
import type { RosterRow } from "../editor/vscode/src/types.js";

const row = (over: Partial<RosterRow> = {}): RosterRow => ({
  id: "s1",
  label: "auth",
  project: "/var/www/bench",
  status: "working",
  latestReportSeq: null,
  answeredReportSeq: null,
  ...over,
});

const HERE = ["/var/www/bench"];

/**
 * A copy of the cockpit's own rule (`src/client/waiting.ts`). Copied rather
 * than imported because the extension is a separate package - and tested
 * here rather than assumed, because a copy that drifts is exactly how the
 * badge starts lying.
 */
describe("isWaiting", () => {
  it("counts a specialist with a report nobody has answered", () => {
    expect(isWaiting(row({ status: "awaiting_decision", latestReportSeq: 3 }))).toBe(true);
  });

  it("does not count one whose latest report has been answered", () => {
    expect(isWaiting(row({ status: "awaiting_decision", latestReportSeq: 3, answeredReportSeq: 3 })))
      .toBe(false);
  });

  /**
   * The trap the cockpit's comment warns about: a specialist that answered a
   * question and wrote no report ends its turn in `awaiting_decision` too.
   * Counting the status alone would badge every idle tab on the bench.
   */
  it("does not count one that merely ended a turn without a report", () => {
    expect(isWaiting(row({ status: "awaiting_decision", latestReportSeq: null }))).toBe(false);
  });

  it("counts a newer report on a specialist already answered once", () => {
    expect(isWaiting(row({ status: "awaiting_decision", latestReportSeq: 4, answeredReportSeq: 3 })))
      .toBe(true);
  });

  it("does not count one that is still working", () => {
    expect(isWaiting(row({ status: "working", latestReportSeq: 3 }))).toBe(false);
  });
});

describe("specialistsHere", () => {
  it("takes a specialist on a project this window has open", () => {
    expect(specialistsHere([row()], HERE).map((r) => r.id)).toEqual(["s1"]);
  });

  it("leaves out a specialist on a project this window does not have open", () => {
    expect(specialistsHere([row({ project: "/var/www/other" })], HERE)).toEqual([]);
  });

  it("is not fooled by a sibling directory with the same prefix", () => {
    expect(specialistsHere([row({ project: "/var/www/bench-old" })], HERE)).toEqual([]);
  });

  /**
   * A row the cockpit learned about from another machine carries paths that
   * mean nothing here, and the daemon this extension talks to cannot serve
   * its diffs either.
   */
  it("leaves out a specialist that belongs to another machine", () => {
    const remote = { ...row({ id: "s2" }), machine: { id: "m2", name: "laptop" } };
    expect(specialistsHere([row(), remote], HERE).map((r) => r.id)).toEqual(["s1"]);
  });

  it("takes specialists from every folder this window has open", () => {
    const rows = [row(), row({ id: "s2", project: "/var/www/other" })];
    expect(specialistsHere(rows, ["/var/www/bench", "/var/www/other"]).map((r) => r.id))
      .toEqual(["s1", "s2"]);
  });

  it("takes nothing when no folder is open", () => {
    expect(specialistsHere([row()], [])).toEqual([]);
  });
});

describe("waitingCount", () => {
  it("counts only what this window could act on", () => {
    const rows = [
      row({ id: "s1", status: "awaiting_decision", latestReportSeq: 1 }),
      row({ id: "s2", status: "awaiting_decision", latestReportSeq: 1, project: "/var/www/other" }),
      row({ id: "s3", status: "working" }),
    ];
    expect(waitingCount(rows, HERE)).toBe(1);
  });

  it("is zero when nobody is waiting", () => {
    expect(waitingCount([row(), row({ id: "s2" })], HERE)).toBe(0);
  });
});
