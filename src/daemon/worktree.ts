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

/**
 * Everything Bench creates inside a target repo, kept out of git via
 * .git/info/exclude rather than .gitignore so the repo's own file is never
 * touched. The worktrees matter as much as the reports: a repo that does
 * not already ignore .claude/ will otherwise commit them as gitlinks.
 */
const BENCH_ARTIFACTS = [".bench/", ".claude/worktrees/"];

export async function excludeBenchDir(repo: string): Promise<void> {
  const excludePath = join(repo, ".git", "info", "exclude");
  await mkdir(join(repo, ".git", "info"), { recursive: true });

  let current = "";
  try {
    current = await readFile(excludePath, "utf8");
  } catch {
    current = "";
  }

  const present = new Set(current.split("\n").map((line) => line.trim()));
  const missing = BENCH_ARTIFACTS.filter((entry) => !present.has(entry));
  if (missing.length === 0) return;

  const next = current.endsWith("\n") || current === "" ? current : current + "\n";
  await writeFile(excludePath, next + missing.join("\n") + "\n");
}
