import { describe, it, expect } from "vitest";
import { progressVisible } from "../src/client/progress.js";

const base = { hasRow: true, steps: null, trailLength: 0, decisionShowing: false };

describe("progressVisible", () => {
  it("shows a checklist while a turn is running", () => {
    expect(progressVisible({ ...base, steps: [{ text: "Fix the guard", state: "doing" }] }))
      .toBe(true);
  });

  it("shows the trail even with no checklist", () => {
    expect(progressVisible({ ...base, trailLength: 3 })).toBe(true);
  });

  it("hides itself while a decision is waiting", () => {
    // A decision means the turn ended, so the checklist above it is stale -
    // and it sits directly above the question being asked.
    expect(progressVisible({
      ...base,
      steps: [{ text: "Write the intake", state: "doing" }],
      trailLength: 5,
      decisionShowing: true,
    })).toBe(false);
  });

  it("stays hidden when nothing has happened yet", () => {
    expect(progressVisible(base)).toBe(false);
  });

  it("stays hidden when no specialist is selected", () => {
    expect(progressVisible({ ...base, hasRow: false, trailLength: 4 })).toBe(false);
  });

  it("treats an empty checklist as nothing to show", () => {
    expect(progressVisible({ ...base, steps: [] })).toBe(false);
  });
});
