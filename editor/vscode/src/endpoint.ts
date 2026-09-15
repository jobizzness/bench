import { join } from "node:path";

/** Only the variables that move the daemon. Everything else is ignored. */
export interface BenchEnv {
  BENCH_HOME?: string;
  BENCH_PORT?: string;
  [key: string]: string | undefined;
}

const DEFAULT_PORT = "7420";

/**
 * Where the daemon keeps the token that is the whole of its authentication.
 *
 * The same rule `config.ts` uses - `BENCH_HOME ?? ~/.bench` - so a developer
 * running a second daemon out of a different home is followed without having
 * to configure the extension at all.
 */
export function tokenPath(env: BenchEnv, homeDir: string): string {
  return join(env.BENCH_HOME ?? join(homeDir, ".bench"), "token");
}

/**
 * The events socket, always on loopback.
 *
 * `BENCH_HOST` is deliberately not read. It widens what the daemon *binds*
 * to, which is a decision about who may reach this machine; it is never a
 * reason for an editor on this machine to go looking somewhere else. Reaching
 * that port is reaching a shell, so the extension only ever talks to itself.
 */
export function eventsUrl(env: BenchEnv, token: string): string {
  const port = env.BENCH_PORT ?? DEFAULT_PORT;
  return `ws://127.0.0.1:${port}/events?token=${encodeURIComponent(token)}`;
}
