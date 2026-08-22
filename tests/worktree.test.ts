import { describe, it, expect } from "vitest";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { makeScratchRepo } from "./helpers/scratch-repo.js";
import { createWorktree, excludeBenchDir, inspectWorktree, removeWorktree } from "../src/daemon/worktree.js";

const exec = promisify(execFile);

const ID_A = "67d92140-3dd1-4311-aed8-c079ba03eba6";
const ID_B = "3c73392c-8661-457d-a87f-ef4bc91fc7a2";

describe("createWorktree", () => {
  it("names the worktree and branch after the session, not the label", async () => {
    // The label is what the developer calls it. Identity is the session id,
    // so two specialists can share a label and a stale branch can never take
    // a name hostage.
    const repo = await makeScratchRepo();
    const { worktree, branch } = await createWorktree(repo, "auth-refresh", ID_A);

    expect(worktree).toBe(join(repo, ".claude", "worktrees", "auth-refresh-67d92140"));
    expect(branch).toBe("bench/auth-refresh-67d92140");

    const { stdout } = await exec("git", ["worktree", "list"], { cwd: repo });
    expect(stdout).toContain(worktree);
  });

  it("lets two specialists share a label in one repo", async () => {
    const repo = await makeScratchRepo();
    const first = await createWorktree(repo, "general", ID_A);
    const second = await createWorktree(repo, "general", ID_B);

    expect(second.worktree).not.toBe(first.worktree);
    expect(second.branch).not.toBe(first.branch);

    const { stdout } = await exec("git", ["worktree", "list"], { cwd: repo });
    expect(stdout).toContain(first.worktree);
    expect(stdout).toContain(second.worktree);
  });

  it("rejects a session id that could escape the worktrees directory", async () => {
    const repo = await makeScratchRepo();
    await expect(createWorktree(repo, "ok", "../../etc")).rejects.toThrow(/invalid session/i);
  });

  it("rejects a label that would escape the worktrees directory", async () => {
    const repo = await makeScratchRepo();
    await expect(createWorktree(repo, "../../etc", ID_A)).rejects.toThrow(/invalid label/i);
  });

  it("never returns a Windows or UNC path", async () => {
    const repo = await makeScratchRepo();
    const { worktree } = await createWorktree(repo, "plain", ID_A);
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
    await createWorktree(repo, "somework", ID_A);

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
    const { worktree, branch } = await createWorktree(repo, "fresh", ID_A);

    const state = await inspectWorktree(repo, worktree, branch);
    expect(state.clean).toBe(true);
    expect(state.changes).toBe(0);
    expect(state.unmergedCommits).toBe(0);
  });

  it("counts uncommitted changes to a tracked file", async () => {
    const repo = await makeScratchRepo();
    const { worktree, branch } = await createWorktree(repo, "dirty", ID_A);
    await writeFile(join(worktree, "README.md"), "changed by a specialist");

    const state = await inspectWorktree(repo, worktree, branch);
    expect(state.clean).toBe(false);
    expect(state.changes).toBe(1);
  });

  it("counts an untracked file, since that is work too", async () => {
    const repo = await makeScratchRepo();
    const { worktree, branch } = await createWorktree(repo, "untracked", ID_A);
    await writeFile(join(worktree, "notes.md"), "a spec nobody committed");

    const state = await inspectWorktree(repo, worktree, branch);
    expect(state.clean).toBe(false);
    expect(state.changes).toBe(1);
  });

  it("counts commits that exist nowhere else", async () => {
    const repo = await makeScratchRepo();
    const { worktree, branch } = await createWorktree(repo, "committed", ID_A);
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
    const { worktree, branch } = await createWorktree(repo, "merged", ID_A);
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
    const { worktree, branch } = await createWorktree(repo, "installed", ID_A);
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
    const { worktree, branch } = await createWorktree(repo, "mixed", ID_A);
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
    const { worktree, branch } = await createWorktree(repo, "gone", ID_A);

    await removeWorktree(repo, worktree, branch);

    const { stdout } = await exec("git", ["worktree", "list"], { cwd: repo });
    expect(stdout).not.toContain(worktree);

    const branches = await exec("git", ["branch", "--list", branch], { cwd: repo });
    expect(branches.stdout.trim()).toBe("");
  });

  it("does not throw when the worktree is already gone", async () => {
    const repo = await makeScratchRepo();
    const { worktree, branch } = await createWorktree(repo, "twice", ID_A);

    await removeWorktree(repo, worktree, branch);
    await expect(removeWorktree(repo, worktree, branch)).resolves.toBeUndefined();
  });
});
