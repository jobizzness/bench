/**
 * An Anthropic API key the developer typed into the cockpit, and what may be
 * said about it afterwards.
 *
 * Nothing here writes to disk. The key is an override for a bench that
 * already has a working `claude` login, and an override kept in a file is one
 * you forget you set - it lives in the daemon's memory and goes when the
 * daemon does.
 */

/** All a key may ever look like once it has been handed over. Enough to
 * recognise which key is set, useless to anyone who reads it. */
export function keyHint(key: string): string {
  // A key short enough that four characters would be most of it is not a real
  // key, and showing it would be showing the key.
  return key.length > 8 ? "…" + key.slice(-4) : "…";
}

/**
 * What the API says about a key.
 *
 * Not a boolean, because "wrong" and "could not ask" call for different
 * answers: one is a typo to fix, the other is a machine that happens to be
 * offline and should still be allowed to keep a key.
 */
export type KeyCheck = "ok" | "refused" | "unreachable";

/**
 * Ask the API, as this key, for the cheapest thing it will answer.
 *
 * Worth the round trip: the CLI does not fail fast on a bad key. It retries a
 * 401 ten times with a doubling delay, so a typo does not read as a typo - it
 * reads as a specialist that hangs for two minutes and then dies.
 */
export async function checkKey(key: string, fetchImpl: typeof fetch = fetch): Promise<KeyCheck> {
  try {
    const res = await fetchImpl("https://api.anthropic.com/v1/models?limit=1", {
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01" },
    });
    if (res.ok) return "ok";
    return res.status === 401 || res.status === 403 ? "refused" : "unreachable";
  } catch {
    // No answer at all: offline, DNS, a proxy in the way. Says nothing about
    // the key.
    return "unreachable";
  }
}
