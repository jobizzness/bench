/**
 * Letting a cockpit that this daemon did not serve talk to it.
 *
 * The client can be hosted anywhere - that is the point of hosting it - and
 * a browser will not let a page on one origin read a response from another
 * without being told it may. So the daemon says so, and the token goes on
 * doing what it has always done: a request without one is refused whether it
 * came from a page on this machine or a page on the far side of the world.
 *
 * Nothing here weakens that. No cookies are involved, so an unauthorised
 * origin gains nothing by being allowed to ask; what it gains is the ability
 * to read the answer to a question it could already have asked.
 */
export function corsHeaders(origin: string | undefined): Record<string, string> {
  // No Origin header at all: a same-origin page, curl, or the CLI. Nothing to
  // negotiate, and adding the headers anyway would only make them look like
  // they mean something.
  if (!origin || origin === "null") return {};

  return {
    "access-control-allow-origin": origin,
    // The answer depends on who asked, so a shared cache must not hand one
    // origin's response to another.
    vary: "Origin",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type, x-bench-token",
    // Chrome will not let a public page touch a private address without
    // asking first, which is exactly what a hosted cockpit reaching a daemon
    // on your desk is.
    "access-control-allow-private-network": "true",
    "access-control-max-age": "600",
  };
}

/** Whether this request is the browser asking permission rather than doing
 * anything. It carries no token, because a preflight never does. */
export function isPreflight(method: string | undefined, origin: string | undefined): boolean {
  return method === "OPTIONS" && Boolean(origin);
}
