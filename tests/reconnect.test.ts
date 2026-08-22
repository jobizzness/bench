import { describe, it, expect } from "vitest";
import { shouldReconnect, UNAUTHORIZED } from "../src/client/reconnect.js";

describe("shouldReconnect", () => {
  it("reconnects when the daemon goes away", () => {
    // The daemon outlives the page; a restart should heal on its own.
    expect(shouldReconnect(1006)).toBe(true);
    expect(shouldReconnect(1001)).toBe(true);
  });

  it("gives up when the token was refused", () => {
    // Asking again with the same token cannot start working.
    expect(shouldReconnect(UNAUTHORIZED)).toBe(false);
  });

  it("treats a normal close as worth retrying", () => {
    expect(shouldReconnect(1000)).toBe(true);
  });
});
