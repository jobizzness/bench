const token = new URLSearchParams(location.search).get("token") ?? "";

/** Every request carries the cockpit token; a 401 means the link is stale. */
export function authFetch(path: string, init?: RequestInit): Promise<Response> {
  return fetch(path, {
    ...init,
    headers: { "x-bench-token": token, ...(init?.headers ?? {}) },
  });
}
