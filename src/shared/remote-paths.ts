/**
 * Which session a route names, shared by the client (to route a call to the
 * right machine) and the daemon (to refuse one naming a session that is not
 * broadcast). One regex pair rather than two, so the two ends cannot drift
 * on what counts as a session route.
 */
export function sessionIdIn(path: string): string | null {
  return path.match(/^\/api\/sessions\/([^/]+)\b/)?.[1]
    ?? path.match(/^\/r\/([^/]+)\//)?.[1]
    ?? null;
}
