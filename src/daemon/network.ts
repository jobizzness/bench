import { setDefaultResultOrder } from "node:dns";
import { setDefaultAutoSelectFamilyAttemptTimeout } from "node:net";

/**
 * How long each address a hostname resolves to gets to connect before Node
 * moves on to the next.
 *
 * Node's default is 250ms, and it applies to every outbound request the
 * daemon makes - `fetch` included. On a link where the TCP handshake to
 * api.anthropic.com alone takes ~900ms and IPv6 has no route at all, every
 * address ran out of time before it could answer, and the whole request
 * failed as ETIMEDOUT while `curl` from the same shell got through. Every
 * managed key then read as "unreachable": never checked, never asked what it
 * had spent, and so never a candidate to rotate onto.
 *
 * Widened rather than turned off: a dual-stack host whose first address is
 * dead still falls back to the next one, just later. IPv4 is tried first so
 * a host with no working IPv6 route does not spend up to 2.5s per AAAA record
 * (and hit undici's 10s connect timeout) before reaching a working A record.
 */
export const CONNECT_ATTEMPT_MS = 2_500;

export function widenConnectAttempts(): void {
  setDefaultResultOrder("ipv4first");
  setDefaultAutoSelectFamilyAttemptTimeout(CONNECT_ATTEMPT_MS);
}
