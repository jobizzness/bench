import { describe, it, expect, afterEach } from "vitest";
import { getDefaultResultOrder, setDefaultResultOrder } from "node:dns";
import { getDefaultAutoSelectFamilyAttemptTimeout, setDefaultAutoSelectFamilyAttemptTimeout } from "node:net";
import { CONNECT_ATTEMPT_MS, widenConnectAttempts } from "../src/daemon/network.js";

/**
 * Node's own default gives each address 250ms to connect before it gives up
 * on it. On a link where a TCP handshake to api.anthropic.com takes ~900ms
 * and IPv6 has no route, every attempt timed out - every managed key read
 * as "unreachable", so none was ever checked, none had usage, and nothing
 * could rotate on it.
 */
describe("widenConnectAttempts", () => {
  const original = getDefaultAutoSelectFamilyAttemptTimeout();
  const originalOrder = getDefaultResultOrder();
  afterEach(() => {
    setDefaultAutoSelectFamilyAttemptTimeout(original);
    setDefaultResultOrder(originalOrder);
  });

  it("gives each address long enough for a slow handshake and prefers ipv4", () => {
    setDefaultAutoSelectFamilyAttemptTimeout(250);
    setDefaultResultOrder("verbatim");
    widenConnectAttempts();
    expect(getDefaultAutoSelectFamilyAttemptTimeout()).toBe(CONNECT_ATTEMPT_MS);
    expect(CONNECT_ATTEMPT_MS).toBeGreaterThanOrEqual(2000);
    expect(getDefaultResultOrder()).toBe("ipv4first");
  });
});
