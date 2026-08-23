/**
 * Which daemon this tab is talking to.
 *
 * The cockpit speaks to whatever served it - every request is a relative path
 * and the socket is built from `location.host`. So pointing it somewhere else
 * is not a setting the client holds, it is a navigation: go there, and
 * everything reloads against the new address. That is also the only version
 * of this that is honest, because a client fetching one daemon while showing
 * another's page would be two states pretending to be one.
 */

/** What a person types, made into an origin. Empty for anything unusable. */
export function toOrigin(typed: string): string {
  const trimmed = typed.trim().replace(/\/+$/, "");
  // Half-typed: a scheme with nothing after it, or a colon with no port. URL
  // parses "http://" into a host called "http", which is worse than refusing.
  if (trimmed === "" || trimmed.endsWith(":")) return "";

  // A bare host or host:port is what anyone actually types.
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  try {
    const url = new URL(withScheme);
    if (url.hostname === "") return "";
    return url.origin;
  } catch {
    return "";
  }
}

/**
 * The same page, at another address, still carrying the token.
 *
 * The path comes along so switching from a phone lands on the specialist you
 * were reading rather than back at the roster.
 */
export function targetUrl(origin: string, token: string, path = "/"): string {
  const clean = origin.replace(/\/+$/, "");
  return `${clean}${path}${token ? `?token=${encodeURIComponent(token)}` : ""}`;
}

/** True when this address is the one the page is already loaded from. */
export function isHere(origin: string): boolean {
  return toOrigin(origin) === location.origin;
}
