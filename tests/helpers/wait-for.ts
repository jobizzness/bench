/**
 * Waits for a condition instead of guessing how long something takes.
 *
 * React mounts and flushes across scheduler turns, so a fixed delay is a bet
 * on machine load: these suites went from green to two thirds skipped between
 * runs because a `beforeAll` gave up 10ms before the roster rendered.
 */
export async function waitFor<T>(
  read: () => T | null | undefined | Promise<T | null | undefined>,
  what = "condition",
  timeoutMs = 3000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
