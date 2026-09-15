export interface AttemptOptions {
  tries: number;
  delayMs: number;
  /** Injected so the tests do not spend real seconds proving they waited. */
  sleep?: (ms: number) => Promise<void>;
}

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Runs something that may be early rather than wrong, and gives up quietly.
 *
 * The edit event rides on the tool call, which the agent sends before the
 * tool runs - so a `Write` that creates a file is announced a moment before
 * the file exists. Returns null rather than throwing: a path this window
 * cannot open is not worth interrupting the developer over, and an unhandled
 * rejection in an extension host is a crash rather than a missed file.
 */
export async function attempt<T>(
  run: () => Promise<T>,
  { tries, delayMs, sleep = realSleep }: AttemptOptions,
): Promise<T | null> {
  for (let i = 0; i < tries; i++) {
    try {
      return await run();
    } catch {
      if (i < tries - 1) await sleep(delayMs);
    }
  }
  return null;
}
