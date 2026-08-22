import { describe, it, expect } from "vitest";
import { resolveTurnOutcome } from "../src/daemon/turn-outcome.js";

describe("resolveTurnOutcome", () => {
  it("reports a failed turn as crashed, with the reason", () => {
    const outcome = resolveTurnOutcome({ isError: true, subtype: "error_max_turns", hasNewReport: false });
    expect(outcome.status).toBe("crashed");
    expect(outcome.detail).toContain("error_max_turns");
  });

  it("treats a failed turn as crashed even if a report exists", () => {
    const outcome = resolveTurnOutcome({ isError: true, subtype: "error", hasNewReport: true });
    expect(outcome.status).toBe("crashed");
  });

  it("says a decision is waiting when a work turn produced a report", () => {
    const outcome = resolveTurnOutcome({ isError: false, subtype: "success", hasNewReport: true });
    expect(outcome.status).toBe("awaiting_decision");
    expect(outcome.detail).toMatch(/waiting on you/i);
  });

  it("does not claim a decision is waiting when there is nothing to read", () => {
    // The roster must never say "waiting on you" with no report behind it.
    const outcome = resolveTurnOutcome({ isError: false, subtype: "success", hasNewReport: false });
    expect(outcome.detail).not.toMatch(/waiting on you/i);
  });

  it("treats a turn that wrote no report as an ordinary reply", () => {
    // Whether a turn warranted a report is the agent's call, so its absence
    // is not a fault to be reported as one.
    const outcome = resolveTurnOutcome({ isError: false, subtype: "success", hasNewReport: false });
    expect(outcome.status).toBe("awaiting_decision");
    expect(outcome.detail).toMatch(/replied/i);
  });
});
