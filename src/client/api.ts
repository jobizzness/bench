/** The cockpit token, from the link the daemon printed. */
export const token = new URLSearchParams(location.search).get("token") ?? "";

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
  const res = await fetch(path, {
    ...init,
    headers: { "x-bench-token": token, ...(init?.headers ?? {}) },
  });
  if (res.status === 401) linkIsStale();
  return res;
}

/**
 * An artifact is loaded by the browser into a frame, which cannot carry a
 * header - so this one URL wears the token in its query string.
 */
export const artifactUrl = (sessionId: string, seq: number, file: string): string =>
  `/r/${sessionId}/${seq}/${file}?token=${encodeURIComponent(token)}`;

export const postJson = (path: string, body: unknown): Promise<Response> =>
  authFetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
