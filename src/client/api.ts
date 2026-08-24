import { currentEndpoint, saveEndpoint, socketUrl, type Endpoint } from "./endpoint.js";

/**
 * The daemon this page is talking to, resolved once on load.
 *
 * Kept in a variable rather than read per call so that every request in a
 * session goes to the same place: told a new address mid-flight, the cockpit
 * reloads rather than half-switching.
 */
let active: Endpoint | null = currentEndpoint();

export const endpoint = (): Endpoint | null => active;

/** Empty when the page has not been told where its daemon is. */
export const token = (): string => active?.token ?? "";

/** Same-origin when the daemon served this page; absolute when it did not. */
export const apiUrl = (path: string): string => `${active?.origin ?? ""}${path}`;

export const eventsUrl = (): string | null => (active ? socketUrl(active) : null);

/**
 * Whether the daemon is somewhere other than where this page came from -
 * which is to say, whether this is a hosted copy of the cockpit that was
 * told where to look. It changes what silence means: a daemon that served
 * this page and then stopped answering is restarting, and one that never
 * answered was probably the wrong address.
 */
export const isRemote = (): boolean => active !== null && active.origin !== location.origin;

/**
 * Point this browser at a daemon and start again there. A reload rather than
 * a re-render: the roster socket, the thread, the queue and the artifact
 * frame all read this, and half of them switching is a cockpit showing two
 * daemons at once.
 */
export function pointAt(next: Endpoint): void {
  saveEndpoint(next);
  active = next;
  location.reload();
}

/**
 * Every request that comes back unauthorised means the same thing, and the
 * page cannot recover from it by trying harder - so it is announced once and
 * whoever is showing the banner listens.
 */
export const STALE_EVENT = "bench:stale";

export function linkIsStale(): void {
  document.dispatchEvent(new Event(STALE_EVENT));
}

/** Every request carries the cockpit token; a 401 means the link is stale. */
export async function authFetch(path: string, init?: RequestInit): Promise<Response> {
  const res = await fetch(apiUrl(path), {
    ...init,
    headers: { "x-bench-token": token(), ...(init?.headers ?? {}) },
  });
  if (res.status === 401) linkIsStale();
  return res;
}

/**
 * An artifact is loaded by the browser into a frame, which cannot carry a
 * header - so this one URL wears the token in its query string.
 */
export const artifactUrl = (sessionId: string, seq: number, file: string): string =>
  apiUrl(`/r/${sessionId}/${seq}/${file}?token=${encodeURIComponent(token())}`);

export const postJson = (path: string, body: unknown): Promise<Response> =>
  authFetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
