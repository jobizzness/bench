import { spawn, type ChildProcess } from "node:child_process";
import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import { execGit, type GitRunner } from "./self-update-watcher.js";

export interface UpdateResult {
  ok: boolean;
  /** Set only when `ok` is false - the plain reason the cockpit shows, and
   * what `POST /api/update` answers with in the body. */
  error?: string;
}

/** How a build step is spawned. Injected so the tests never run a real
 * `pnpm install` or `pnpm build`. */
export type ProcSpawner = (cmd: string, args: string[], cwd: string) => ChildProcess;

const realSpawn: ProcSpawner = (cmd, args, cwd) => spawn(cmd, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The first tap: pull, install if the lockfile moved, build. Modelled on the
 * developer's own accepted risk (see the ticket) - this runs while the
 * daemon is live and still importing from `dist/`, so every failure path
 * below puts the checkout back exactly where it found it rather than
 * leaving a commit pulled with nothing built for it.
 *
 * Refuses outright - before touching anything - on a dirty tree or a merge
 * that would not fast-forward. Never stashes, never merges over local work.
 */
export async function runSelfUpdate(deps: {
  root: string;
  home: string;
  git?: GitRunner;
  spawnProc?: ProcSpawner;
  /** Bounded so a build that hangs cannot wedge the watcher forever. */
  timeoutMs?: number;
}): Promise<UpdateResult> {
  const git = deps.git ?? execGit;
  const root = deps.root;

  const statusOut = (await git(["status", "--porcelain"], root)).stdout;
  if (statusOut.trim() !== "") {
    return { ok: false, error: "the checkout has uncommitted changes" };
  }

  const branch = (await git(["rev-parse", "--abbrev-ref", "HEAD"], root)).stdout.trim();
  const oldHead = (await git(["rev-parse", "HEAD"], root)).stdout.trim();

  try {
    await git(["fetch", "--quiet", "origin", branch], root);
  } catch (error) {
    return { ok: false, error: `could not fetch: ${message(error)}` };
  }

  const target = `origin/${branch}`;
  try {
    await git(["merge-base", "--is-ancestor", "HEAD", target], root);
  } catch {
    return { ok: false, error: "the branch has diverged from its remote and cannot fast-forward" };
  }

  try {
    await git(["merge", "--ff-only", target], root);
  } catch (error) {
    return { ok: false, error: `git merge --ff-only failed: ${message(error)}` };
  }

  const newHead = (await git(["rev-parse", "HEAD"], root)).stdout.trim();
  if (newHead === oldHead) return { ok: true };

  const log = join(deps.home, "update.log");
  const append = async (line: string) => {
    await appendFile(log, `${new Date().toISOString()} ${line}\n`).catch(() => {});
  };
  const rollback = async (reason: string): Promise<UpdateResult> => {
    await git(["reset", "--hard", oldHead], root);
    return { ok: false, error: `${reason} - rolled the checkout back to ${oldHead.slice(0, 8)}. See ${log}` };
  };

  const changedFiles = (await git(["diff", "--name-only", `${oldHead}..${newHead}`], root)).stdout;
  const lockfileChanged = changedFiles.split("\n").some((f) => f.trim() === "pnpm-lock.yaml");

  const run = (cmd: string, args: string[]): Promise<number> => new Promise((resolve) => {
    const child = (deps.spawnProc ?? realSpawn)(cmd, args, root);
    const timer = setTimeout(() => child.kill("SIGKILL"), deps.timeoutMs ?? 10 * 60_000);
    timer.unref?.();
    child.stdout?.on("data", (chunk: Buffer) => void append(chunk.toString()));
    child.stderr?.on("data", (chunk: Buffer) => void append(chunk.toString()));
    child.on("close", (code) => { clearTimeout(timer); resolve(code ?? 1); });
    child.on("error", (error) => { clearTimeout(timer); void append(message(error)); resolve(1); });
  });

  if (lockfileChanged) {
    await append("$ pnpm install --frozen-lockfile");
    const code = await run("pnpm", ["install", "--frozen-lockfile"]);
    if (code !== 0) return rollback(`pnpm install failed (exit ${code})`);
  }

  await append("$ pnpm build");
  const buildCode = await run("pnpm", ["build"]);
  if (buildCode !== 0) return rollback(`pnpm build failed (exit ${buildCode})`);

  return { ok: true };
}
