import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { makeScratchRepo } from "./helpers/scratch-repo.js";
import { createWorktree, excludeBenchDir } from "../src/daemon/worktree.js";

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

  it("is idempotent", async () => {
    const repo = await makeScratchRepo();
    await excludeBenchDir(repo);
    await excludeBenchDir(repo);
    const exclude = await readFile(join(repo, ".git", "info", "exclude"), "utf8");
    expect(exclude.match(/\.bench\//g)).toHaveLength(1);
  });
});
