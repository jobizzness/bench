import { handling, SHELL_ASSETS, SHELL_PAGE } from "./sw-policy.js";

/**
 * The cockpit's service worker.
 *
 * It exists for two ordinary moments: the daemon being restarted under a page
 * that is open, and Bench being launched from a home screen with nothing to
 * connect to. In both, a cached shell means the app draws its own frame and
 * says what is wrong, instead of the browser drawing a dinosaur.
 *
 * Every request goes to the network first. On a machine where the server is
 * the same machine that is nothing, and it means the cockpit can never be a
 * version behind the daemon it is talking to.
 */

/** Bumped when the shell's file list changes; old caches go on activate. */
const CACHE = "bench-shell-v1";

interface Lifecycle extends Event {
  waitUntil(work: Promise<unknown>): void;
}

interface Fetching extends Event {
  request: Request;
  respondWith(response: Response | Promise<Response>): void;
}

/** The worker's own globals. Declared here rather than pulling the WebWorker
 * lib in beside DOM, which would redeclare half of it. */
const worker = self as unknown as {
  addEventListener(type: "install" | "activate", handler: (event: Lifecycle) => void): void;
  addEventListener(type: "fetch", handler: (event: Fetching) => void): void;
  skipWaiting(): Promise<void>;
  clients: { claim(): Promise<void> };
};

/** Network first, cache as the fallback, under a key of our choosing so a
 * navigation to /s/<id> can fall back to the shell cached at /. */
async function fresh(request: Request, key: string): Promise<Response> {
  const cache = await caches.open(CACHE);
  try {
    const response = await fetch(request);
    // A 404 or a 500 is an answer from a daemon that is up, and caching it
    // would hand it back later as if it were the shell.
    if (response.ok) await cache.put(key, response.clone());
    return response;
  } catch (unreachable) {
    const kept = await cache.match(key);
    if (kept) return kept;
    throw unreachable;
  }
}

worker.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // One at a time, and failures forgiven: `addAll` is all-or-nothing, so a
    // single missing icon would leave the cockpit with no cached shell at all.
    await Promise.allSettled([SHELL_PAGE, ...SHELL_ASSETS].map((path) => cache.add(path)));
    await worker.skipWaiting();
  })());
});

worker.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter((name) => name !== CACHE).map((name) => caches.delete(name)));
    // Take the pages that are already open, so a rebuilt shell does not wait
    // for every tab to be closed first.
    await worker.clients.claim();
  })());
});

worker.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  const how = handling({
    method: event.request.method,
    mode: event.request.mode,
    sameOrigin: url.origin === location.origin,
    pathname: url.pathname,
  });

  if (how === "pass") return;
  event.respondWith(fresh(event.request, how === "page" ? SHELL_PAGE : url.pathname));
});
