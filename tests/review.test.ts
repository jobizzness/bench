import { describe, it, expect } from "vitest";
import { reviewBrief, reviewLabel } from "../src/daemon/review.js";
import { LABEL_MAX } from "../src/shared/slug.js";

/**
 * A reviewer is only worth opening if it argues. What these hold in place is
 * the brief - the difference between "review this" and a review is entirely
 * in what it was asked for.
 */

describe("naming a reviewer", () => {
  it("names it after what it is reviewing, the way a person would", () => {
    // A label is read by people; the branch under it is slugged elsewhere.
    expect(reviewLabel("Cash pickup")).toBe("Review of Cash pickup");
  });

  it("stays inside what a label is allowed to be", () => {
    expect(reviewLabel("a".repeat(200)).length).toBeLessThanOrEqual(LABEL_MAX);
  });
});

describe("what the reviewer is told", () => {
  const brief = reviewBrief({
    label: "payouts",
    branch: "bench/payouts-abcd1234",
    reportPath: "/var/www/bench/.bench/reports/abc/4/report.html",
  });

  it("names the branch, and how to read it", () => {
    expect(brief).toContain("bench/payouts-abcd1234");
    expect(brief).toContain("git diff main...bench/payouts-abcd1234");
  });

  it("says the branch is not its to change", () => {
    // It has its own worktree. Editing the branch under review is how a
    // review becomes a second author.
    expect(brief).toContain("do not change it");
  });

  it("asks for the diff before the claims", () => {
    // A reviewer that reads the report first is reviewing the report.
    expect(brief.indexOf("git diff")).toBeLessThan(brief.indexOf("report.html"));
    expect(brief).toContain("before its");
  });

  it("asks it to disagree rather than to summarise", () => {
    expect(brief).toContain("disagree with it");
    expect(brief).toContain("not to approve it");
  });

  it("names what to look for, so it is not left to invent a checklist", () => {
    expect(brief).toContain("Verified list that the diff does not support");
    expect(brief).toContain("the case it did not think of");
  });

  it("lets it find nothing", () => {
    // A review that always finds three things is a review nobody can act on.
    expect(brief).toContain("If you find nothing worth their time");
  });

  it("says nothing about a report when there is none to read", () => {
    const without = reviewBrief({ label: "payouts", branch: "b", reportPath: null });
    expect(without).not.toContain("report.html");
    expect(without).toContain("disagree with it");
  });
});
