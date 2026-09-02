import { spawn } from "node:child_process";
import { openSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { clearLaunch, LAUNCH_VARS, readLaunch, recipeFromProc, type LaunchRecipe } from "../daemon/launch.js";

/**
 * Restarting the daemon from inside something the daemon is running.
 *
 * Shutdown stops every specialist (`daemon/index.ts`), so whoever asks for a
 * restart is asking to be killed. That is the whole difficulty: the work has
 * to outlive its caller, and it has to wait long enough for the caller's turn
 * to have been written down before anything is stopped.
 *
 * So `bench restart` does almost nothing itself - it starts a detached copy
 * of this same CLI and returns. Everything below happens in that copy, with
 * no terminal and nobody waiting on it.
 */

/** How the detached half is invoked. Not in the help text: it is an internal
 * hand-off, and running it by hand does the same thing as `restart` while
 * looking like a supported command. */
export const WORKER_COMMAND = "__restart-worker";

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // Somebody else's process still counts as running.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function until(
  ready: () => boolean | Promise<boolean>,
  { timeoutMs, everyMs = 250, now = Date.now }: { timeoutMs: number; everyMs?: number; now?: () => number },
): Promise<boolean> {
  const deadline = now() + timeoutMs;
  for (;;) {
    if (await ready()) return true;
    if (now() >= deadline) return false;
    await sleep(everyMs);
  }
}

/** The environment a fresh daemon should get: this shell's, minus everything
 * Bench sets - so a specialist's own `BENCH_SESSION_ID` cannot leak into the
 * daemon it restarts - plus the recipe the old one was started with. */
export function daemonEnv(
  recipe: LaunchRecipe,
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const base: NodeJS.ProcessEnv = { ...source };
  for (const key of Object.keys(base)) {
    if (key.startsWith("BENCH_")) delete base[key];
  }
  for (const name of LAUNCH_VARS) delete base[name];
  return { ...base, ...recipe.env };
}

/** Starts the detached half and returns. The caller is about to be stopped
 * by it, so nothing here waits. */
export function askForRestart(home: string, build: boolean, cliPath: string): void {
  const log = openSync(join(home, "restart.log"), "a");
  const child = spawn(process.execPath, [cliPath, WORKER_COMMAND, ...(build ? ["--build"] : [])], {
    detached: true,
    stdio: ["ignore", log, log],
    env: { ...process.env, BENCH_RESTART_HOME: home },
  });
  child.unref();
}

async function noTurnRunning(base: string, token: string): Promise<boolean> {
  try {
    const res = await fetch(`${base}/api/roster`, { headers: { "x-bench-token": token } });
    if (!res.ok) return true;
    const body = await res.json() as { rows?: Array<{ status?: string }> };
    return !(body.rows ?? []).some((row) => row.status === "working");
  } catch {
    // Nothing answering is not a turn in flight.
    return true;
  }
}

/**
 * The daemon running right now started before it knew to write a recipe, so
 * there is a lock naming it and nothing saying how to run it again. Rather
 * than refuse - which would mean this command only works after somebody has
 * restarted by hand once - read it back off the process itself.
 */
function fromLock(home: string, say: (line: string) => void): LaunchRecipe | null {
  let pid = 0;
  try {
    pid = Number(readFileSync(join(home, "daemon.lock"), "utf8").trim());
  } catch {
    return null;
  }
  if (!Number.isInteger(pid) || pid <= 0 || !alive(pid)) return null;

  const found = recipeFromProc(pid);
  if (!found) return null;
  say(`no recipe on disk; read pid ${pid}'s own command line instead`);
  return { ...found, startedAt: "" };
}

export interface RestartOptions {
  home: string;
  build: boolean;
  base: string;
  token: string;
  say: (line: string) => void;
  /** Bounded so a specialist that never finishes cannot block a restart
   * forever. Short in tests. */
  idleTimeoutMs?: number;
  stopTimeoutMs?: number;
  upTimeoutMs?: number;
}

/**
 * The detached half, in order: let turns finish, stop, build, start, prove it
 * came up. Every step says what it is doing, because the only record of a
 * restart nobody watched is this log.
 */
export async function runRestart(opts: RestartOptions): Promise<number> {
  const { home, build, base, token, say } = opts;
  const recipe = readLaunch(home) ?? fromLock(home, say);

  if (recipe && alive(recipe.pid)) {
    say(`waiting for turns to finish (pid ${recipe.pid})`);
    const idle = await until(() => noTurnRunning(base, token), { timeoutMs: opts.idleTimeoutMs ?? 120_000 });
    say(idle ? "no turn running" : "a turn is still running; restarting anyway");
  }

  if (build) {
    const cwd = recipe?.cwd ?? process.cwd();
    say(`building in ${cwd}`);
    const code = await new Promise<number>((resolve) => {
      const child = spawn("pnpm", ["build"], { cwd, stdio: "inherit" });
      child.on("close", (c) => resolve(c ?? 1));
      child.on("error", () => resolve(1));
    });
    if (code !== 0) {
      // Deliberately before the stop. A daemon that will not start is worse
      // than the one that was already running.
      say(`build failed (${code}); the running daemon has not been touched`);
      return code;
    }
    say("build ok");
  }

  if (recipe && alive(recipe.pid)) {
    say(`stopping pid ${recipe.pid}`);
    try {
      process.kill(recipe.pid, "SIGTERM");
    } catch {
      // Gone between the check and the signal. Nothing to stop.
    }
    // The lock is released at the moment of exit, so waiting for the process
    // rather than for the file is the same wait and a more honest one.
    const stopped = await until(() => !alive(recipe.pid), { timeoutMs: opts.stopTimeoutMs ?? 20_000 });
    if (!stopped) {
      say(`pid ${recipe.pid} did not stop; leaving it alone rather than forcing it`);
      return 1;
    }
    say("stopped");
    // It should have cleared its own; a daemon killed harder than SIGTERM
    // will not have.
    clearLaunch(home, recipe.pid);
  } else {
    say(recipe ? "recorded daemon is not running" : "no daemon has run in this home");
  }

  if (!recipe) {
    say("nothing to start again - run `pnpm start` once and restart will know how");
    return 1;
  }

  const out = openSync(join(home, "daemon.log"), "a");
  say(`starting: ${recipe.argv.join(" ")}`);
  const child = spawn(recipe.argv[0], recipe.argv.slice(1), {
    cwd: recipe.cwd,
    env: daemonEnv(recipe),
    detached: true,
    stdio: ["ignore", out, out],
  });
  child.unref();

  const up = await until(
    async () => {
      try {
        return (await fetch(`${base}/api/addresses`, { headers: { "x-bench-token": token } })).ok;
      } catch {
        return false;
      }
    },
    { timeoutMs: opts.upTimeoutMs ?? 30_000 },
  );

  say(up ? "up" : `no answer on ${base} yet - see ${join(home, "daemon.log")}`);
  return up ? 0 : 1;
}
