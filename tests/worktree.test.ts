import { describe, it, expect } from "vitest";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { makeScratchRepo } from "./helpers/scratch-repo.js";
import { createWorktree, excludeBenchDir, inspectWorktree, removeWorktree } from "../src/daemon/worktree.js";

const exec = promisify(execFile);

describe("createWorktree", () => {
  it("creates a worktree under .claude/worktrees on its own branch", async () => {
    const repo = await makeScratchRepo();
    const { worktree, branch } = await createWorktree(repo, "auth-refresh");

    expect(worktree).toBe(join(repo, ".claude", "worktrees", "auth-refresh"));
    expect(branch).toBe("worktree-auth-refresh");

    const { stdout } = await exec("git", ["worktree", "list"], { cwd: repo });
    expect(stdout).toContain(worktree);
  });

  it("rejects a label that would escape the worktrees directory", async () => {
    const repo = await makeScratchRepo();
    await expect(createWorktree(repo, "../../etc")).rejects.toThrow(/invalid label/i);
  });

  it("never returns a Windows or UNC path", async () => {
    const repo = await makeScratchRepo();
    const { worktree } = await createWorktree(repo, "plain");
    expect(worktree.startsWith("/")).toBe(true);
    expect(worktree).not.toContain("\\");
  });
});

describe("excludeBenchDir", () => {
  it("excludes .bench via .git/info/exclude, leaving .gitignore untouched", async () => {
    const repo = await makeScratchRepo();
    await excludeBenchDir(repo);

    const exclude = await readFile(join(repo, ".git", "info", "exclude"), "utf8");
    expect(exclude).toContain(".bench/");

    const { stdout } = await exec("git", ["status", "--porcelain"], { cwd: repo });
    expect(stdout).not.toContain(".gitignore");
  });

  it("also excludes the worktrees directory", async () => {
    // Without this, a repo that does not already ignore .claude/ commits
    // Bench's worktrees as gitlinks.
    const repo = await makeScratchRepo();
    await excludeBenchDir(repo);
    await createWorktree(repo, "somework");

    const { stdout } = await exec("git", ["status", "--porcelain"], { cwd: repo });
    expect(stdout).not.toContain(".claude/worktrees");
  });

  it("adds a missing entry to an exclude file that already has the other", async () => {
    const repo = await makeScratchRepo();
    await writeFile(join(repo, ".git", "info", "exclude"), ".bench/\n");
    await excludeBenchDir(repo);

    const exclude = await readFile(join(repo, ".git", "info", "exclude"), "utf8");
    expect(exclude).toContain(".claude/worktrees/");
    expect(exclude.match(/\.bench\//g)).toHaveLength(1);
  });

  it("is idempotent", async () => {
    const repo = await makeScratchRepo();
    await excludeBenchDir(repo);
    await excludeBenchDir(repo);
    const exclude = await readFile(join(repo, ".git", "info", "exclude"), "utf8");
    expect(exclude.match(/\.bench\//g)).toHaveLength(1);
  });
});

describe("inspectWorktree", () => {
  it("calls a freshly created worktree clean", async () => {
    const repo = await makeScratchRepo();
    const { worktree, branch } = await createWorktree(repo, "fresh");

    const state = await inspectWorktree(repo, worktree, branch);
    expect(state.clean).toBe(true);
    expect(state.changes).toBe(0);
    expect(state.unmergedCommits).toBe(0);
  });

  it("counts uncommitted changes to a tracked file", async () => {
    const repo = await makeScratchRepo();
    const { worktree, branch } = await createWorktree(repo, "dirty");
    await writeFile(join(worktree, "README.md"), "changed by a specialist");

    const state = await inspectWorktree(repo, worktree, branch);
    expect(state.clean).toBe(false);
    expect(state.changes).toBe(1);
  });

  it("counts an untracked file, since that is work too", async () => {
    const repo = await makeScratchRepo();
    const { worktree, branch } = await createWorktree(repo, "untracked");
    await writeFile(join(worktree, "notes.md"), "a spec nobody committed");

    const state = await inspectWorktree(repo, worktree, branch);
    expect(state.clean).toBe(false);
    expect(state.changes).toBe(1);
  });

  it("counts commits that exist nowhere else", async () => {
    const repo = await makeScratchRepo();
    const { worktree, branch } = await createWorktree(repo, "committed");
    await writeFile(join(worktree, "feature.txt"), "done");
    await exec("git", ["add", "-A"], { cwd: worktree });
    await exec("git", ["commit", "-qm", "add feature"], { cwd: worktree });

    const state = await inspectWorktree(repo, worktree, branch);
    expect(state.clean).toBe(false);
    expect(state.unmergedCommits).toBe(1);
    expect(state.changes).toBe(0);
  });

  it("calls a merged branch clean, since nothing would be lost", async () => {
    const repo = await makeScratchRepo();
    const { worktree, branch } = await createWorktree(repo, "merged");
    await writeFile(join(worktree, "feature.txt"), "done");
    await exec("git", ["add", "-A"], { cwd: worktree });
    await exec("git", ["commit", "-qm", "add feature"], { cwd: worktree });
    await exec("git", ["merge", "--no-ff", "-m", "merge", branch], { cwd: repo });

    const state = await inspectWorktree(repo, worktree, branch);
    expect(state.clean).toBe(true);
  });
});

describe("inspectWorktree and bootstrap leftovers", () => {
  it("ignores what bootstrap itself created", async () => {
    // Every worktree is installed into, so node_modules and a generated
    // lockfile are Bench's own doing. Counting them would make every
    // specialist look like it had unsaved work and close would never run.
    const repo = await makeScratchRepo();
    const { worktree, branch } = await createWorktree(repo, "installed");
    await mkdir(join(worktree, "node_modules"), { recursive: true });
    await writeFile(join(worktree, "node_modules", "x.js"), "//");
    await writeFile(join(worktree, "pnpm-lock.yaml"), "lockfileVersion: 9");
    await writeFile(join(worktree, ".env"), "SECRET=1");

    const state = await inspectWorktree(repo, worktree, branch);
    expect(state.clean).toBe(true);
    expect(state.changes).toBe(0);
  });

  it("still counts real work beside those leftovers", async () => {
    const repo = await makeScratchRepo();
    const { worktree, branch } = await createWorktree(repo, "mixed");
    await mkdir(join(worktree, "node_modules"), { recursive: true });
    await writeFile(join(worktree, "node_modules", "x.js"), "//");
    await writeFile(join(worktree, "notes.md"), "a spec nobody committed");

    const state = await inspectWorktree(repo, worktree, branch);
    expect(state.clean).toBe(false);
    expect(state.changes).toBe(1);
  });
});

describe("removeWorktree", () => {
  it("removes the worktree and its branch", async () => {
    const repo = await makeScratchRepo();
    const { worktree, branch } = await createWorktree(repo, "gone");

    await removeWorktree(repo, worktree, branch);

    const { stdout } = await exec("git", ["worktree", "list"], { cwd: repo });
    expect(stdout).not.toContain(worktree);

    const branches = await exec("git", ["branch", "--list", branch], { cwd: repo });
    expect(branches.stdout.trim()).toBe("");
  });

  it("does not throw when the worktree is already gone", async () => {
    const repo = await makeScratchRepo();
    const { worktree, branch } = await createWorktree(repo, "twice");

    await removeWorktree(repo, worktree, branch);
    await expect(removeWorktree(repo, worktree, branch)).resolves.toBeUndefined();
  });
});
