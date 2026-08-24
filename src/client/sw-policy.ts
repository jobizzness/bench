/**
 * What the service worker is allowed to touch.
 *
 * Bench is a cockpit over a daemon that is right there on the machine, so
 * there is nothing to gain by serving it stale and a great deal to lose: an
 * answered decision drawn from a cache is worse than no cockpit at all. The
 * worker therefore keeps a copy of the shell - the page, its script, its
 * stylesheet, its icons - and stands entirely out of the way of everything
 * that carries live state.
 *
 * Kept apart from the worker itself so the rule can be read and tested
 * without a service worker to run it in.
 */

/** The document every cockpit URL renders. Cached under this one key, so a
 * cold start at /s/<id> falls back to the same shell. */
export const SHELL_PAGE = "/";

/** Everything the shell needs to draw itself with the daemon unreachable. */
export const SHELL_ASSETS = [
  "/app.js",
  "/styles.css",
  "/favicon.svg",
  "/icon.svg",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/apple-touch-icon.png",
] as const;

export type Handling =
  /** A cockpit document: serve fresh, fall back to the cached shell. */
  | "page"
  /** A shell file: serve fresh, fall back to the cached copy. */
  | "asset"
  /** Not ours. The worker does not answer, and the browser goes as it would
   * have gone without one. */
  | "pass";

/** The shell answers at the root and at every specialist's own URL. */
export function isShellPath(pathname: string): boolean {
  return pathname === "/" || /^\/s\/[A-Za-z0-9-]+\/?$/.test(pathname);
}

export function handling(request: {
  method: string;
  /** `navigate` for a document the browser is going to; `same-origin`,
   * `cors` and the rest for everything a page asks for itself. */
  mode: string;
  sameOrigin: boolean;
  pathname: string;
}): Handling {
  // Answering, sending and closing are not cacheable in any sense, and a
  // worker that touched them could replay one.
  if (request.method !== "GET") return "pass";
  if (!request.sameOrigin) return "pass";

  if (request.mode === "navigate") {
    // A report opened in its own tab is served from the daemon and belongs
    // to a session; there is no offline version of it to give.
    return isShellPath(request.pathname) ? "page" : "pass";
  }

  // Named one by one rather than matched by extension. The manifest is the
  // reason: it carries the cockpit token, and a cache is a place a token
  // outlives the daemon that issued it.
  return (SHELL_ASSETS as readonly string[]).includes(request.pathname) ? "asset" : "pass";
}
