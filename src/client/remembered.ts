/**
 * The small preferences a browser should carry between visits.
 *
 * Not state the daemon owns - which specialists exist, what they have said -
 * but how one person has arranged the view in front of them. That belongs to
 * the browser it was arranged in, and it should survive a refresh without
 * anybody having to think about it.
 *
 * Every call is guarded. Storage is disabled outright in some browsers and
 * throws on write in others, and a cockpit that will not render because it
 * could not remember which projects were folded away is worse than one that
 * forgets.
 */
const PREFIX = "bench:";

export function recall<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    // No storage, or something that is not JSON because a hand or an older
    // version of this put it there.
    return fallback;
  }
}

export function remember(key: string, value: unknown): void {
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(value));
  } catch {
    // Full, or refused. Nothing here is worth interrupting anyone over.
  }
}
