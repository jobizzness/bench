import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { labelIsUsable, slugify } from "../shared/slug.js";

const exec = promisify(execFile);

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
  if (!labelIsUsable(label)) {
    throw new Error(`invalid label: ${label}`);
  }
  if (!SESSION_ID_PATTERN.test(sessionId)) {
    throw new Error(`invalid session id: ${sessionId}`);
  }

  // The label leads so `git branch` stays readable; the id makes it unique.
  // Slugged here rather than demanded of the developer: "Cash pickup" is what
  // a person calls a specialist, and `cash-pickup-abcd1234` is what git can
  // hold. Both are true at once, and only one of them should have to be typed.
  const name = `${slugify(label)}-${sessionId.slice(0, 8)}`;
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

  // Commits reachable from this branch and from nowhere else. Every other ref
  // is listed explicitly rather than using `--all`, which would include this
  // branch and so always report nothing. Comparing against all branches
  // rather than a guessed default means a branch merged anywhere counts as
  // nothing to lose.
  //
  // Remote-tracking refs count too, and leaving them out was a bug: pushing is
  // how a specialist's work becomes safe, and it is the moment closing its tab
  // becomes the right thing to do - so the guard fired hardest exactly where
  // it should have relaxed, and said "on no other branch" about commits that
  // were demonstrably on one.
  let unmergedCommits = 0;
  try {
    const { stdout: refs } = await exec(
      "git", ["for-each-ref", "--format=%(refname)", "refs/heads/", "refs/remotes/"], { cwd: repo },
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

/** One file a specialist has changed since its branch started. */
export interface ChangedFile {
  /** Relative to the worktree root. */
  path: string;
  /** git's letter: `A`, `M`, `D`, `R`. An untracked file reads as `A`. */
  status: string;
  /** On the branch already, rather than only on disk. */
  committed: boolean;
}

export interface Changes {
  /** The commit the branch started from. Null when it cannot be read, which
   * is also what an absent worktree gives back. */
  base: string | null;
  files: ChangedFile[];
}

/** The same, plus the directory every path in it is relative to. Added at
 * the registry, which is what knows where a specialist's tree actually is. */
export interface SessionChanges extends Changes {
  root: string;
}

/** `git status --porcelain` prints `XY path`; the first non-space letter is
 * the one worth showing, and `?` means untracked, which is a file being
 * added. */
function porcelainStatus(code: string): string {
  const letter = code.trim()[0] ?? "M";
  return letter === "?" ? "A" : letter;
}

/** git quotes a path containing anything unusual. */
const unquote = (path: string) => path.trim().replace(/^"|"$/g, "");

/**
 * What a specialist has actually done to the repo, file by file.
 *
 * `inspectWorktree` above parses exactly this and returns only a count,
 * because all it has to answer is "would closing this lose anything". The
 * editor's sidebar asks the harder version of the same question, so this
 * keeps the names.
 *
 * Measured from where the branch started, not from its HEAD. Specialists
 * commit as they work, and a list that empties itself on every commit goes
 * blank exactly when there is most to look at.
 *
 * The starting point is the merge base with whatever the developer has
 * checked out, because that is what `createWorktree` branched from. A
 * specialist working in the checkout itself shares that branch, so its base
 * is its own HEAD and only uncommitted work shows - which is right, since
 * its commits are the developer's commits.
 */
export async function changedFiles(
  repo: string,
  worktree: string,
  branch: string,
): Promise<Changes> {
  let porcelain: string;
  try {
    const { stdout } = await exec("git", ["status", "--porcelain"], { cwd: worktree });
    porcelain = stdout;
  } catch {
    // No worktree on disk. Nothing to show and nothing to measure against.
    return { base: null, files: [] };
  }

  const base = await branchBase(repo, worktree, branch);

  // Committed first, so the uncommitted pass below can overwrite a path that
  // appears in both: what is on disk is the newer truth, and the one the
  // developer can still do something about.
  const byPath = new Map<string, ChangedFile>();

  if (base !== null) {
    try {
      const { stdout } = await exec(
        "git", ["diff", "--name-status", base, "HEAD"], { cwd: worktree },
      );
      for (const line of stdout.split("\n")) {
        if (line.trim() === "") continue;
        const fields = line.split("\t");
        // A rename prints `R100<tab>old<tab>new`. The new name is the file.
        const path = unquote(fields[fields.length - 1]);
        byPath.set(path, { path, status: fields[0].trim()[0] ?? "M", committed: true });
      }
    } catch {
      // A branch with no commits of its own. Uncommitted work still counts.
    }
  }

  for (const line of porcelain.split("\n")) {
    if (line.trim() === "") continue;
    // Bench's own leavings - the linked node_modules, a regenerated lockfile.
    // Only untracked ones, exactly as `inspectWorktree` forgives them.
    if (isBootstrapLeftover(line)) continue;
    const path = unquote(line.slice(3));
    byPath.set(path, { path, status: porcelainStatus(line.slice(0, 2)), committed: false });
  }

  return { base, files: [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path)) };
}

/**
 * A file as it was at a commit, for the left-hand side of a diff.
 *
 * Empty string, not null, for a path that did not exist then: that is what
 * makes a new file read as entirely added rather than as an error. Null is
 * reserved for "cannot answer" - a bad commit, a path that is not ours.
 */
export async function fileAtCommit(
  worktree: string,
  commit: string,
  path: string,
): Promise<string | null> {
  // The path arrives on a query string. git will not resolve outside the
  // repository itself, but a route handing user input to a shell should not
  // lean on that alone.
  if (path.startsWith("/") || path.split("/").includes("..")) return null;

  try {
    const { stdout } = await exec("git", ["show", `${commit}:${path}`], {
      cwd: worktree,
      maxBuffer: 16 * 1024 * 1024,
    });
    return stdout;
  } catch (error) {
    const stderr = String((error as { stderr?: string }).stderr ?? "");
    // git prints the same "not in '<rev>'" for a file that did not exist yet
    // and for a commit it cannot read at all, so the message cannot tell
    // them apart. Ask whether the commit is real instead: absent from a
    // commit that exists means the file is new, which is an empty left-hand
    // side. Anything else means we cannot answer.
    if (!/does not exist in|exists on disk, but not in/i.test(stderr)) return null;
    return (await commitExists(worktree, commit)) ? "" : null;
  }
}

async function commitExists(worktree: string, commit: string): Promise<boolean> {
  try {
    await exec("git", ["cat-file", "-e", `${commit}^{commit}`], { cwd: worktree });
    return true;
  } catch {
    return false;
  }
}

/**
 * Where this branch parted company with the developer's.
 *
 * Read in the worktree rather than the repo so it still answers when the
 * developer has since checked something else out.
 */
async function branchBase(repo: string, worktree: string, branch: string): Promise<string | null> {
  try {
    const against = await currentBranch(repo);
    const { stdout } = await exec("git", ["merge-base", branch, against], { cwd: worktree });
    return stdout.trim() || null;
  } catch {
    // Nothing shared, or a branch git does not know. Fall back to the
    // worktree's own HEAD: uncommitted work is still worth showing.
    try {
      const { stdout } = await exec("git", ["rev-parse", "HEAD"], { cwd: worktree });
      return stdout.trim() || null;
    } catch {
      return null;
    }
  }
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
