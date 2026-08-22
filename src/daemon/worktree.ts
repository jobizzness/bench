import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

const exec = promisify(execFile);

const LABEL_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

const SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The label is what the developer calls a specialist; it is not its identity.
 * Naming the branch after the label meant two specialists could never share
 * one, and a branch left behind by a specialist Bench no longer knew about
 * held that name forever - provisioning failed with a raw git error and no
 * way forward but renaming. The session id is the identity, so the label is
 * free to repeat and a stale branch collides with nothing.
 */
export async function createWorktree(
  repo: string,
  label: string,
  sessionId: string,
): Promise<{ worktree: string; branch: string }> {
  if (!LABEL_PATTERN.test(label)) {
    throw new Error(`invalid label: ${label}`);
  }
  if (!SESSION_ID_PATTERN.test(sessionId)) {
    throw new Error(`invalid session id: ${sessionId}`);
  }

  // The label leads so `git branch` stays readable; the id makes it unique.
  const name = `${label}-${sessionId.slice(0, 8)}`;
  const worktree = join(repo, ".claude", "worktrees", name);
  const branch = `bench/${name}`;

  await mkdir(join(repo, ".claude", "worktrees"), { recursive: true });
  await exec("git", ["worktree", "add", "-b", branch, worktree], { cwd: repo });

  return { worktree, branch };
}

/**
 * The branch the developer already has checked out. Recorded rather than
 * assumed for a specialist working in the checkout itself, so the roster can
 * say where it is - and so nothing later guesses "main" and deletes it.
 */
export async function currentBranch(repo: string): Promise<string> {
  try {
    const { stdout } = await exec("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: repo });
    return stdout.trim() || "HEAD";
  } catch {
    return "HEAD";
  }
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


/**
 * Bench links node_modules and the env files into every worktree it creates,
 * so those, and a lockfile some tool regenerated, are its own leavings rather
 * than the specialist's work. Counting them would make every worktree look
 * unsaved and close would refuse forever.
 *
 * Only untracked entries are forgiven. A lockfile the repo actually tracks
 * shows as modified, not untracked, and still counts.
 */
const BOOTSTRAP_LEFTOVERS = [
  "node_modules/",
  "pnpm-lock.yaml",
  "package-lock.json",
  "yarn.lock",
  ".env",
  ".env.local",
  ".env.production",
  ".bench/",
  ".claude/",
];

function isBootstrapLeftover(statusLine: string): boolean {
  if (!statusLine.startsWith("??")) return false;
  const path = statusLine.slice(3).trim().replace(/^"|"$/g, "");
  return BOOTSTRAP_LEFTOVERS.some((entry) => {
    if (!entry.endsWith("/")) return path === entry;
    // git prints a directory with its trailing slash but a symlink to one
    // without it, and bootstrap links node_modules rather than creating it.
    // Matching only the slashed form left every worktree looking unsaved.
    return path === entry || path === entry.slice(0, -1) || path.startsWith(entry);
  });
}

export interface WorktreeState {
  /** Nothing would be lost by removing it. */
  clean: boolean;
  /** Uncommitted changes, untracked files included - work is work. */
  changes: number;
  /** Commits on this branch that exist nowhere else in the repo. */
  unmergedCommits: number;
}

/**
 * What closing a specialist would destroy. A worktree is cheap to recreate
 * and its contents are not: the only irreversible part of closing one is the
 * work inside it, so it is counted before anything is removed.
 */
export async function inspectWorktree(
  repo: string,
  worktree: string,
  branch: string,
): Promise<WorktreeState> {
  let changes = 0;
  try {
    const { stdout } = await exec("git", ["status", "--porcelain"], { cwd: worktree });
    changes = stdout.split("\n")
      .filter((line) => line.trim() !== "")
      .filter((line) => !isBootstrapLeftover(line))
      .length;
  } catch {
    // No worktree on disk means nothing to lose.
    return { clean: true, changes: 0, unmergedCommits: 0 };
  }

  // Commits reachable from this branch and from no other branch. Every other
  // ref is listed explicitly rather than using `--all`, which would include
  // this branch and so always report nothing. Comparing against all branches
  // rather than a guessed default means a branch merged anywhere counts as
  // nothing to lose.
  let unmergedCommits = 0;
  try {
    const { stdout: refs } = await exec(
      "git", ["for-each-ref", "--format=%(refname)", "refs/heads/"], { cwd: repo },
    );
    const others = refs.split("\n")
      .map((r) => r.trim())
      .filter((r) => r !== "" && r !== `refs/heads/${branch}`);

    if (others.length > 0) {
      const { stdout } = await exec(
        "git", ["rev-list", "--count", branch, "--not", ...others], { cwd: repo },
      );
      unmergedCommits = Number(stdout.trim()) || 0;
    }
  } catch {
    unmergedCommits = 0;
  }

  return { clean: changes === 0 && unmergedCommits === 0, changes, unmergedCommits };
}

/** Remove the worktree and the branch it was created on. Idempotent. */
export async function removeWorktree(
  repo: string,
  worktree: string,
  branch: string,
): Promise<void> {
  try {
    await exec("git", ["worktree", "remove", "--force", worktree], { cwd: repo });
  } catch {
    // Already gone, or never registered. Prune so `git worktree list` agrees.
    await exec("git", ["worktree", "prune"], { cwd: repo }).catch(() => {});
  }
  await exec("git", ["branch", "-D", branch], { cwd: repo }).catch(() => {});
}
