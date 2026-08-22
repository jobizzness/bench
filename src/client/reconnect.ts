/** The daemon refuses an unauthorised socket with this code. */
export const UNAUTHORIZED = 1008;

/**
 * Whether a closed socket is worth retrying.
 *
 * A dropped connection is: the daemon outlives the page, so reconnecting is
 * right. A refused one is not - the token will not become valid by asking
 * again, and retrying it silently is what made a stale link look like every
 * specialist had disappeared.
 */
export function shouldReconnect(code: number): boolean {
  return code !== UNAUTHORIZED;
}
