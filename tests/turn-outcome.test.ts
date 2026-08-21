import { describe, it, expect } from "vitest";
import { resolveTurnOutcome } from "../src/daemon/turn-outcome.js";

describe("resolveTurnOutcome", () => {
  it("reports a failed turn as crashed, with the reason", () => {
    const outcome = resolveTurnOutcome({ isError: true, subtype: "error_max_turns", kind: "work", hasNewReport: false });
    expect(outcome.status).toBe("crashed");
    expect(outcome.detail).toContain("error_max_turns");
  });

  it("treats a failed turn as crashed even if a report exists", () => {
    const outcome = resolveTurnOutcome({ isError: true, subtype: "error", kind: "work", hasNewReport: true });
    expect(outcome.status).toBe("crashed");
  });

  it("says a decision is waiting when a work turn produced a report", () => {
    const outcome = resolveTurnOutcome({ isError: false, subtype: "success", kind: "work", hasNewReport: true });
    expect(outcome.status).toBe("awaiting_decision");
    expect(outcome.detail).toMatch(/waiting on you/i);
  });

  it("does not claim a decision is waiting when a work turn produced no report", () => {
    // This is the state that made the marker race so confusing: the roster
    // said "waiting on you" with nothing to read.
    const outcome = resolveTurnOutcome({ isError: false, subtype: "success", kind: "work", hasNewReport: false });
    expect(outcome.detail).not.toMatch(/waiting on you/i);
    expect(outcome.detail).toMatch(/without a report/i);
  });

  it("describes a chat turn as replied", () => {
    const outcome = resolveTurnOutcome({ isError: false, subtype: "success", kind: "chat", hasNewReport: false });
    expect(outcome.status).toBe("awaiting_decision");
    expect(outcome.detail).toMatch(/replied/i);
  });
});
