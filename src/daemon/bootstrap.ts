import { execFile } from "node:child_process";
import { readFile, symlink, access } from "node:fs/promises";
import { join } from "node:path";

export type RunFn = (
  cmd: string,
  args: string[],
  cwd: string,
) => Promise<{ code: number; stderr: string }>;

export interface BootstrapOptions {
  repo: string;
  worktree: string;
  port: number;
  onStep?: (name: string) => void;
  run?: RunFn;
}

export interface BootstrapResult {
  port: number;
  steps: string[];
}

export class BootstrapError extends Error {
  constructor(
    readonly step: string,
    readonly stderr: string,
  ) {
    super(`bootstrap step "${step}" failed: ${stderr.trim().slice(0, 400)}`);
    this.name = "BootstrapError";
  }
}

/** Files that never live in git but that the app needs to run. */
const ENV_FILES = [".env", ".env.local", ".env.production"];

const defaultRun: RunFn = (cmd, args, cwd) =>
  new Promise((resolve) => {
    execFile(cmd, args, { cwd, maxBuffer: 32 * 1024 * 1024 }, (error, _stdout, stderr) => {
      resolve({ code: error ? 1 : 0, stderr: stderr ?? String(error ?? "") });
    });
  });

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function usesPrisma(repo: string): Promise<boolean> {
  try {
    const pkg = JSON.parse(await readFile(join(repo, "package.json"), "utf8"));
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    return "prisma" in deps || "@prisma/client" in deps;
  } catch {
    return false;
  }
}

/**
 * A fresh worktree has no node_modules and no env files, so it cannot run
 * anything. This makes it runnable, and fails loudly on the step that broke
 * rather than leaving the agent to discover it at its first test run.
 */
export async function bootstrapWorktree(opts: BootstrapOptions): Promise<BootstrapResult> {
  const { repo, worktree, port, onStep } = opts;
  const run = opts.run ?? defaultRun;
  const steps: string[] = [];

  const step = async (name: string, fn: () => Promise<void>) => {
    steps.push(name);
    onStep?.(name);
    await fn();
  };

  await step("install", async () => {
    const { code, stderr } = await run("pnpm", ["install", "--prefer-offline"], worktree);
    if (code !== 0) throw new BootstrapError("install", stderr);
  });

  await step("env", async () => {
    for (const file of ENV_FILES) {
      const source = join(repo, file);
      const target = join(worktree, file);
      if (!(await exists(source))) continue;
      if (await exists(target)) continue;
      // Symlink, never copy: secrets keep one source of truth on disk.
      await symlink(source, target);
    }
  });

  if (await usesPrisma(repo)) {
    await step("prisma", async () => {
      const { code, stderr } = await run("pnpm", ["exec", "prisma", "generate"], worktree);
      if (code !== 0) throw new BootstrapError("prisma", stderr);
    });
  }

  return { port, steps };
}
