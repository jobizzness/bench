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
 * Whether this is a token from `claude setup-token` rather than a key from
 * the console.
 *
 * The two are told apart by prefix because that is how the API tells them
 * apart: `sk-ant-oat…` is an OAuth token, answered only on the Authorization
 * header, and `sk-ant-api…` is a key, answered only on x-api-key. Sent the
 * wrong way round either one comes back 401 - indistinguishable from a typo.
 */
export function isOauthToken(key: string): boolean {
  return key.startsWith("sk-ant-oat");
}

/** How to present a credential so the API reads it as what it is. */
function authHeaders(key: string): Record<string, string> {
  return isOauthToken(key)
    ? { authorization: `Bearer ${key}`, "anthropic-beta": "oauth-2025-04-20" }
    : { "x-api-key": key };
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
      headers: { ...authHeaders(key), "anthropic-version": "2023-06-01" },
    });
    if (res.ok) return "ok";
    return res.status === 401 || res.status === 403 ? "refused" : "unreachable";
  } catch {
    // No answer at all: offline, DNS, a proxy in the way. Says nothing about
    // the key.
    return "unreachable";
  }
}

/**
 * The environment a child `claude` should inherit to authenticate as this
 * credential.
 *
 * One variable or the other, never both: the CLI reads a setup-token from
 * CLAUDE_CODE_OAUTH_TOKEN and a console key from ANTHROPIC_API_KEY, and
 * neither will do for the other.
 */
export function credentialEnv(key: string): Record<string, string> {
  return isOauthToken(key) ? { CLAUDE_CODE_OAUTH_TOKEN: key } : { ANTHROPIC_API_KEY: key };
}
