import { readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * How this daemon was started, written down so it can be started that way
 * again.
 *
 * A restart that guesses is a restart that quietly changes the daemon: drop
 * `BENCH_LAN` and the cockpit stops answering on the network without saying
 * so, drop `BENCH_HOME` and the new process is looking at a different roster
 * entirely. Neither fails loudly, which is what makes guessing the wrong
 * approach rather than merely an imprecise one.
 *
 * It sits beside `daemon.lock` and has the same lifetime: written when the
 * lock is taken, removed when it is released.
 */
export interface LaunchRecipe {
  pid: number;
  /** Where the daemon was started from. `pnpm start` resolves `dist/` and
   * the projects root relative to this, so it is not incidental. */
  cwd: string;
  /** `process.argv`, entry script included - the thing to run again. */
  argv: string[];
  /** Only Bench's own variables. The daemon's environment holds far more
   * than this and most of it belongs to the shell that started it; copying
   * the lot would pin a restart to one terminal's history. */
  env: Record<string, string>;
  startedAt: string;
}

const FILE = "daemon.json";

/** Everything Bench reads from its own environment. Kept as a list rather
 * than a prefix match so that adding one is a deliberate act - a restart
 * that silently starts honouring a new variable is a restart that changed
 * something. */
export const LAUNCH_VARS = [
  "BENCH_HOME", "BENCH_PORT", "BENCH_HOST", "BENCH_LAN",
  "BENCH_PROJECTS_ROOT", "BENCH_TOKEN", "BENCH_COCKPIT_PORT",
] as const;

export function launchEnv(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const kept: Record<string, string> = {};
  for (const name of LAUNCH_VARS) {
    const value = source[name];
    if (typeof value === "string" && value !== "") kept[name] = value;
  }
  return kept;
}

export function launchPath(home: string): string {
  return join(home, FILE);
}

/** Called where the lock is taken, so the two always agree about who is
 * running. */
export function writeLaunch(home: string, recipe: Omit<LaunchRecipe, "startedAt">): void {
  writeFileSync(
    launchPath(home),
    JSON.stringify({ ...recipe, startedAt: new Date().toISOString() }, null, 2) + "\n",
  );
}

/** Null rather than throwing: no file means no daemon has run here, which is
 * a thing a restart has to handle rather than an error. */
export function readLaunch(home: string): LaunchRecipe | null {
  try {
    const parsed = JSON.parse(readFileSync(launchPath(home), "utf8")) as LaunchRecipe;
    if (!Number.isInteger(parsed.pid) || !Array.isArray(parsed.argv) || parsed.argv.length === 0) {
      return null;
    }
    return { ...parsed, env: parsed.env ?? {} };
  } catch {
    return null;
  }
}

/**
 * The recipe for a daemon that started before there were recipes.
 *
 * Every daemon running when this landed - and every one started from a
 * checkout older than it - has a lock but no `daemon.json`, and refusing to
 * restart those would mean the feature only works after somebody has already
 * restarted by hand, which is the thing it exists to avoid.
 *
 * Linux only, deliberately: `/proc` is where this reads from, and Bench runs
 * in WSL. Anywhere else this returns null and the recipe file is the answer.
 */
export function recipeFromProc(pid: number, procRoot = "/proc"): Omit<LaunchRecipe, "startedAt"> | null {
  try {
    const nulSeparated = (name: string): string[] =>
      readFileSync(join(procRoot, String(pid), name), "utf8").split("\0").filter((s) => s !== "");

    const argv = nulSeparated("cmdline");
    if (argv.length === 0) return null;

    const env: Record<string, string> = {};
    for (const entry of nulSeparated("environ")) {
      const at = entry.indexOf("=");
      if (at <= 0) continue;
      const key = entry.slice(0, at);
      if ((LAUNCH_VARS as readonly string[]).includes(key)) env[key] = entry.slice(at + 1);
    }

    return { pid, cwd: realpathSync(join(procRoot, String(pid), "cwd")), argv, env };
  } catch {
    // No /proc, no such process, or a kernel that will not show us its
    // environment. The caller falls back to saying it cannot restart.
    return null;
  }
}

export function clearLaunch(home: string, pid: number): void {
  try {
    // Only ever our own, for the reason the lock gives: a daemon shutting
    // down after another took over must not delete the new one's record.
    if (readLaunch(home)?.pid === pid) rmSync(launchPath(home));
  } catch {
    // Already gone.
  }
}
