import { describe, it, expect } from "vitest";
import { lstat, readlink, writeFile, mkdir, chmod } from "node:fs/promises";
import { join } from "node:path";
import { makeScratchRepo } from "./helpers/scratch-repo.js";
import { createWorktree } from "../src/daemon/worktree.js";

const ID = "67d92140-3dd1-4311-aed8-c079ba03eba6";
import { bootstrapWorktree, BootstrapError } from "../src/daemon/bootstrap.js";

/** A main checkout that has already been installed into. */
async function withModules(repo: string): Promise<string> {
  const modules = join(repo, "node_modules");
  await mkdir(join(modules, "left-pad"), { recursive: true });
  await writeFile(join(modules, "left-pad", "index.js"), "//");
  return modules;
}

describe("bootstrapWorktree", () => {
  it("symlinks .env from the main checkout instead of copying it", async () => {
    const repo = await makeScratchRepo();
    const { worktree } = await createWorktree(repo, "envtest", ID);

    await bootstrapWorktree({ repo, worktree, port: 3101 });

    const link = join(worktree, ".env");
    expect((await lstat(link)).isSymbolicLink()).toBe(true);
    expect(await readlink(link)).toBe(join(repo, ".env"));
  });

  it("links node_modules from the main checkout rather than installing one", async () => {
    const repo = await makeScratchRepo();
    const modules = await withModules(repo);
    const { worktree } = await createWorktree(repo, "linked", ID);

    await bootstrapWorktree({ repo, worktree, port: 3107 });

    const link = join(worktree, "node_modules");
    expect((await lstat(link)).isSymbolicLink()).toBe(true);
    expect(await readlink(link)).toBe(modules);
  });

  it("resolves a real dependency through the link", async () => {
    const repo = await makeScratchRepo();
    await withModules(repo);
    const { worktree } = await createWorktree(repo, "resolves", ID);

    await bootstrapWorktree({ repo, worktree, port: 3108 });

    const entry = join(worktree, "node_modules", "left-pad", "index.js");
    expect((await lstat(entry)).isFile()).toBe(true);
  });

  it("reports each step it ran, in order", async () => {
    const repo = await makeScratchRepo();
    await withModules(repo);
    const { worktree } = await createWorktree(repo, "steps", ID);

    const seen: string[] = [];
    const result = await bootstrapWorktree({
      repo, worktree, port: 3102, onStep: (s) => seen.push(s),
    });

    expect(seen[0]).toBe("link");
    expect(seen).toContain("env");
    expect(result.port).toBe(3102);
  });

  it("never runs an install, even for a project that has none of its deps yet", async () => {
    const repo = await makeScratchRepo();
    const { worktree } = await createWorktree(repo, "noinstall", ID);

    const seen: string[] = [];
    await bootstrapWorktree({ repo, worktree, port: 3103, onStep: (s) => seen.push(s) });

    expect(seen).not.toContain("install");
  });

  it("skips the link when the main checkout has no node_modules to lend", async () => {
    const repo = await makeScratchRepo();
    const { worktree } = await createWorktree(repo, "nomodules", ID);

    await bootstrapWorktree({ repo, worktree, port: 3109 });

    await expect(lstat(join(worktree, "node_modules"))).rejects.toThrow();
  });

  it("leaves a node_modules the worktree already has alone", async () => {
    const repo = await makeScratchRepo();
    await withModules(repo);
    const { worktree } = await createWorktree(repo, "existing", ID);
    await mkdir(join(worktree, "node_modules"), { recursive: true });

    await bootstrapWorktree({ repo, worktree, port: 3110 });

    expect((await lstat(join(worktree, "node_modules"))).isDirectory()).toBe(true);
  });

  it("no longer generates a prisma client, which would write through the link", async () => {
    const repo = await makeScratchRepo();
    await withModules(repo);
    await writeFile(
      join(repo, "package.json"),
      JSON.stringify({ name: "scratch", devDependencies: { prisma: "^7.0.0" } }),
    );
    const { worktree } = await createWorktree(repo, "prisma", ID);

    const seen: string[] = [];
    await bootstrapWorktree({ repo, worktree, port: 3104, onStep: (s) => seen.push(s) });

    expect(seen).not.toContain("prisma");
  });

  it("surfaces the failing step as a BootstrapError", async () => {
    const repo = await makeScratchRepo();
    await withModules(repo);
    const { worktree } = await createWorktree(repo, "failing", ID);
    // A worktree it cannot write into is the one failure this step still has.
    await chmod(worktree, 0o500);

    try {
      await expect(
        bootstrapWorktree({ repo, worktree, port: 3105 }),
      ).rejects.toMatchObject({ step: "link" });
      await expect(
        bootstrapWorktree({ repo, worktree, port: 3106 }),
      ).rejects.toBeInstanceOf(BootstrapError);
    } finally {
      await chmod(worktree, 0o700);
    }
  });
});
