/**
 * Routes that only a program on this machine may call (#174).
 *
 * The token is not enough for these: the cockpit can be opened from other
 * devices, and these routes hand out an Anthropic key, which must never leave
 * the machine.
 */
const LOOPBACK_ONLY_PATHS = new Set([
  "/api/anthropic-keys/active",
  "/api/anthropic-keys/exhausted",
]);

/** The socket's own peer, as the kernel reported it. Node gives an IPv4 peer
 * on a dual-stack listener as `::ffff:127.0.0.1`. */
const LOOPBACK_PEERS = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

/**
 * Whether a connection comes from this machine. Takes the socket's remote
 * address and nothing else: a header such as `x-forwarded-for` is whatever
 * the client chose to write.
 */
export function isLoopbackPeer(address: string | undefined): boolean {
  return address !== undefined && LOOPBACK_PEERS.has(address);
}

/**
 * Whether a request path names a loopback-only route, for the remote relay,
 * which runs a phone's command against this server over loopback and would
 * otherwise be waved through.
 *
 * Parsed by appending it to an origin, exactly as the relay's own call does,
 * so a query string, a `./` segment or a backslash cannot make this read one
 * path while the server routes another. Anything that will not parse is
 * treated as loopback-only: refusing it costs nothing.
 */
export function isLoopbackOnlyPath(path: string): boolean {
  try {
    return LOOPBACK_ONLY_PATHS.has(new URL(`http://127.0.0.1:7420${path}`).pathname);
  } catch {
    return true;
  }
}
