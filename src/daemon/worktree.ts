import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

const exec = promisify(execFile);

const LABEL_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

export async function createWorktree(
  repo: string,
  label: string,
): Promise<{ worktree: string; branch: string }> {
  if (!LABEL_PATTERN.test(label)) {
    throw new Error(`invalid label: ${label}`);
  }

  const worktree = join(repo, ".claude", "worktrees", label);
  const branch = `worktree-${label}`;

  await mkdir(join(repo, ".claude", "worktrees"), { recursive: true });
  await exec("git", ["worktree", "add", "-b", branch, worktree], { cwd: repo });

  return { worktree, branch };
}

export async function excludeBenchDir(repo: string): Promise<void> {
  const excludePath = join(repo, ".git", "info", "exclude");
  await mkdir(join(repo, ".git", "info"), { recursive: true });

  let current = "";
  try {
    current = await readFile(excludePath, "utf8");
  } catch {
    current = "";
  }

  if (current.split("\n").some((line) => line.trim() === ".bench/")) return;

  const next = current.endsWith("\n") || current === "" ? current : current + "\n";
  await writeFile(excludePath, next + ".bench/\n");
}
