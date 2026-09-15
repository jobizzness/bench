import { describe, it, expect } from "vitest";
import { rateLimitFrom } from "../src/daemon/stream-codec.js";

/**
 * What a specialist's own stream says about the key it is spending.
 *
 * A setup-token cannot be asked for its usage - the usage endpoint wants a
 * scope `claude setup-token` does not grant - but every turn the CLI runs on
 * one reports it anyway, in a `rate_limit_event`. This is the event exactly
 * as `claude -p --output-format stream-json` wrote it on this bench.
 */
const REAL = {
  type: "rate_limit_event",
  rate_limit_info: {
    status: "allowed",
    resetsAt: 1789519800,
    rateLimitType: "five_hour",
    overageStatus: "rejected",
    isUsingOverage: false,
    unifiedWindows: {
      five_hour: { utilization: 0.17, resetsAt: 1789519800 },
      seven_day: { utilization: 0.31, resetsAt: 1789941600 },
    },
  },
  uuid: "u-1",
  session_id: "s-1",
};

const iso = (seconds: number) => new Date(seconds * 1000).toISOString();

describe("rateLimitFrom", () => {
  it("reads each window as the bars the profile already draws", () => {
    expect(rateLimitFrom(REAL)).toEqual({
      status: "allowed",
      resetsAt: iso(1789519800),
      windows: [
        { key: "five_hour", label: "5-hour", percent: 17, resetsAt: iso(1789519800) },
        { key: "seven_day", label: "7-day", percent: 31, resetsAt: iso(1789941600) },
      ],
    });
  });

  it("stops a window that ran past its cap at full", () => {
    const over = { ...REAL, rate_limit_info: { ...REAL.rate_limit_info, status: "rejected", unifiedWindows: {
      five_hour: { utilization: 1.04, resetsAt: 1789519800 },
    } } };
    expect(rateLimitFrom(over)).toMatchObject({
      status: "rejected",
      windows: [{ key: "five_hour", percent: 100 }],
    });
  });

  it("still says whether the key is refused when no windows came with it", () => {
    const bare = { type: "rate_limit_event", rate_limit_info: { status: "rejected", resetsAt: 1789519800 } };
    expect(rateLimitFrom(bare)).toEqual({ status: "rejected", resetsAt: iso(1789519800), windows: [] });
  });

  it("ignores every other event", () => {
    expect(rateLimitFrom({ type: "system", subtype: "init" })).toBeNull();
    expect(rateLimitFrom({ type: "rate_limit_event" })).toBeNull();
  });
});
