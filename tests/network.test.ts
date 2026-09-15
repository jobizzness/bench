import { describe, it, expect, afterEach } from "vitest";
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
  afterEach(() => setDefaultAutoSelectFamilyAttemptTimeout(original));

  it("gives each address long enough for a slow handshake", () => {
    setDefaultAutoSelectFamilyAttemptTimeout(250);
    widenConnectAttempts();
    expect(getDefaultAutoSelectFamilyAttemptTimeout()).toBe(CONNECT_ATTEMPT_MS);
    expect(CONNECT_ATTEMPT_MS).toBeGreaterThanOrEqual(2000);
  });
});
