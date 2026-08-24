/**
 * Making the cockpit installable.
 *
 * Two things have to happen from the page, and both are here because both
 * are about the token. The manifest is fetched by the browser rather than by
 * us, so its link has to carry the token in its href - a header cannot be
 * attached to it. And the worker is registered only where a browser will
 * take one at all.
 */

/** The manifest is per-token, so the link is written at runtime rather than
 * sitting in index.html with a blank in it. */
export function manifestHref(token: string): string {
  return `/manifest.webmanifest?token=${encodeURIComponent(token)}`;
}

/**
 * Replaces the link rather than adding one, so a page that somehow runs this
 * twice does not leave the browser choosing between two manifests.
 *
 * Without a token the link goes to the plain manifest instead. That is the
 * copy of the cockpit on static hosting, which is installed first and told
 * which daemon it belongs to afterwards - it has no token to carry, and it
 * still has to be installable, since being installable is why it is hosted.
 */
export function installManifest(doc: Document, token: string): void {
  const link = doc.querySelector<HTMLLinkElement>('link[rel="manifest"]')
    ?? doc.head.appendChild(Object.assign(doc.createElement("link"), { rel: "manifest" }));
  link.href = token === "" ? "/manifest.webmanifest" : manifestHref(token);
}

/**
 * A service worker needs a secure context, and http://192.168.x.x is not one.
 * So the cockpit installs fully on this machine and, reached from a phone
 * over the network, degrades to what iOS gives a manifest on its own: an
 * icon, a name, and a standalone window with no cached shell behind it.
 *
 * Nothing here is load-bearing, so a browser that refuses is not an error the
 * developer needs to hear about.
 */
export async function registerWorker(): Promise<boolean> {
  if (!window.isSecureContext) return false;
  if (!("serviceWorker" in navigator)) return false;

  try {
    await navigator.serviceWorker.register("/sw.js", { scope: "/" });
    return true;
  } catch {
    return false;
  }
}
