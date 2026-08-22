import { symlink, access } from "node:fs/promises";
import { join } from "node:path";

export interface BootstrapOptions {
  repo: string;
  worktree: string;
  port: number;
  onStep?: (name: string) => void;
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

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * A fresh worktree has no node_modules and no env files, so it cannot run
 * anything. Bootstrap makes it runnable without installing: the main
 * checkout has already resolved and linked every dependency, and a worktree
 * is the same commit tree, so it can borrow that node_modules wholesale.
 *
 * Installing instead cost eight to seventeen seconds per specialist and
 * produced a tree the main checkout already had. Copying was worse - a pnpm
 * node_modules is thousands of files, and hardlinking them one by one took
 * thirteen times longer than the install it replaced.
 *
 * The link is one-way in intent only: writes through it land in the main
 * checkout, which is why the dependency commands that would do so are denied
 * to specialists in gates/settings.ts. Nothing here can enforce that, so the
 * two have to stay in step.
 */
export async function bootstrapWorktree(opts: BootstrapOptions): Promise<BootstrapResult> {
  const { repo, worktree, port, onStep } = opts;
  const steps: string[] = [];

  const step = async (name: string, fn: () => Promise<void>) => {
    steps.push(name);
    onStep?.(name);
    try {
      await fn();
    } catch (error) {
      throw new BootstrapError(name, String(error));
    }
  };

  await step("link", async () => {
    const source = join(repo, "node_modules");
    const target = join(worktree, "node_modules");
    // A project with nothing installed has nothing to lend; the specialist
    // is no worse off than the developer who opened the same repo.
    if (!(await exists(source))) return;
    if (await exists(target)) return;
    await symlink(source, target);
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

  return { port, steps };
}
