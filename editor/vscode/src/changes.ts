import type { Changes } from "./types.js";

/** Nothing to show. What every failure here resolves to. */
const NOTHING: Changes = { base: null, files: [] };

/**
 * What a specialist has changed since its branch started.
 *
 * Never throws. A specialist closed while the sidebar was open, a daemon
 * that stopped, a route that 404s - all of them mean "nothing to draw", and
 * a tree provider that rejects takes its whole view down with it.
 */
export async function fetchChanges(base: string, token: string, id: string): Promise<Changes> {
  try {
    const res = await fetch(`${base}/api/sessions/${encodeURIComponent(id)}/changes`, {
      headers: { "x-bench-token": token },
    });
    if (!res.ok) return NOTHING;
    return (await res.json()) as Changes;
  } catch {
    return NOTHING;
  }
}

/**
 * One of those files as it was before the specialist touched it - the left
 * side of the diff.
 *
 * Empty string on any failure, not null: an empty left side makes the diff
 * read as "all of this is new", which is both true of a new file and the
 * least misleading thing to show when we simply could not find out.
 */
export async function fetchBaseBlob(
  base: string,
  token: string,
  id: string,
  path: string,
): Promise<string> {
  try {
    const url = `${base}/api/sessions/${encodeURIComponent(id)}/blob`
      + `?path=${encodeURIComponent(path)}`;
    const res = await fetch(url, { headers: { "x-bench-token": token } });
    if (!res.ok) return "";
    return ((await res.json()) as { content?: string }).content ?? "";
  } catch {
    return "";
  }
}
