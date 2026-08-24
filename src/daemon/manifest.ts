/**
 * The web app manifest, built per request rather than served from a file.
 *
 * The reason is `start_url`. An installed Bench has no address bar to paste a
 * link into, so the URL it launches must already carry the cockpit token -
 * and a token in a static file beside app.js would be a shell on this machine
 * handed to anyone on the network who asks for /manifest.webmanifest. It is
 * built here from the token the request already proved it had, which means
 * the manifest can only ever be read by somebody who could already open the
 * cockpit.
 */
export function benchManifest(token: string): object {
  const start = `/?token=${encodeURIComponent(token)}`;

  return {
    // Fixed, and not the start_url: the id is how a browser recognises an
    // already-installed Bench, and a token in it would install a second copy
    // every time the daemon minted a new one.
    id: "/bench",
    name: "Bench",
    short_name: "Bench",
    description: "Supervise Claude Code specialists and answer what they ask.",
    start_url: start,
    scope: "/",
    display: "standalone",
    // The cockpit is dark and says so, so the window chrome and the splash
    // are drawn in its own background rather than in white.
    background_color: "#0b1210",
    theme_color: "#0b1210",
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      // The same drawing serves both: the mark sits at 52% of the square, so
      // a launcher cropping it to a circle takes nothing but ground.
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
      { src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
    ],
    // What a long-press on the installed icon offers. One entry, because
    // there is one thing you open Bench to do.
    shortcuts: [
      {
        name: "Waiting on you",
        url: `${start}#queue`,
        icons: [{ src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" }],
      },
    ],
  };
}
