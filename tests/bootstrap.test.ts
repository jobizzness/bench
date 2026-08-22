import { describe, it, expect } from "vitest";
import { lstat, readlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { makeScratchRepo } from "./helpers/scratch-repo.js";
import { createWorktree } from "../src/daemon/worktree.js";

const ID = "67d92140-3dd1-4311-aed8-c079ba03eba6";
import { bootstrapWorktree, BootstrapError } from "../src/daemon/bootstrap.js";

const okRun = async () => ({ code: 0, stderr: "" });

describe("bootstrapWorktree", () => {
  it("symlinks .env from the main checkout instead of copying it", async () => {
    const repo = await makeScratchRepo();
    const { worktree } = await createWorktree(repo, "envtest", ID);

    await bootstrapWorktree({ repo, worktree, port: 3101, run: okRun });

    const link = join(worktree, ".env");
    expect((await lstat(link)).isSymbolicLink()).toBe(true);
    expect(await readlink(link)).toBe(join(repo, ".env"));
  });

  it("reports each step it ran, in order", async () => {
    const repo = await makeScratchRepo();
    const { worktree } = await createWorktree(repo, "steps", ID);

    const seen: string[] = [];
    const result = await bootstrapWorktree({
      repo, worktree, port: 3102, run: okRun, onStep: (s) => seen.push(s),
    });

    expect(seen[0]).toBe("install");
    expect(seen).toContain("env");
    expect(result.port).toBe(3102);
  });

  it("skips prisma generate when the project has no prisma dependency", async () => {
    const repo = await makeScratchRepo();
    const { worktree } = await createWorktree(repo, "noprisma", ID);

    const seen: string[] = [];
    await bootstrapWorktree({ repo, worktree, port: 3103, run: okRun, onStep: (s) => seen.push(s) });

    expect(seen).not.toContain("prisma");
  });

  it("runs prisma generate when prisma is a dependency", async () => {
    const repo = await makeScratchRepo();
    await writeFile(
      join(repo, "package.json"),
      JSON.stringify({ name: "scratch", devDependencies: { prisma: "^7.0.0" } }),
    );
    const { worktree } = await createWorktree(repo, "prisma", ID);

    const seen: string[] = [];
    await bootstrapWorktree({ repo, worktree, port: 3104, run: okRun, onStep: (s) => seen.push(s) });

    expect(seen).toContain("prisma");
  });

  it("surfaces the failing step and its stderr", async () => {
    const repo = await makeScratchRepo();
    const { worktree } = await createWorktree(repo, "failing", ID);

    const failingRun = async () => ({ code: 1, stderr: "ERR_PNPM_NO_LOCKFILE" });

    await expect(
      bootstrapWorktree({ repo, worktree, port: 3105, run: failingRun }),
    ).rejects.toMatchObject({
      step: "install",
      stderr: expect.stringContaining("ERR_PNPM_NO_LOCKFILE"),
    });
  });

  it("throws a BootstrapError, not a bare Error", async () => {
    const repo = await makeScratchRepo();
    const { worktree } = await createWorktree(repo, "errtype", ID);
    const failingRun = async () => ({ code: 1, stderr: "boom" });

    await expect(
      bootstrapWorktree({ repo, worktree, port: 3106, run: failingRun }),
    ).rejects.toBeInstanceOf(BootstrapError);
  });
});
