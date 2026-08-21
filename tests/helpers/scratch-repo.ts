import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

/** A throwaway git repo with one commit, shaped like a small pnpm project. */
export async function makeScratchRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "bench-scratch-"));
  await exec("git", ["init", "-q", "-b", "main"], { cwd: dir });
  await exec("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  await exec("git", ["config", "user.name", "Test"], { cwd: dir });
  await mkdir(join(dir, ".git", "info"), { recursive: true });
  await writeFile(join(dir, "package.json"), JSON.stringify({ name: "scratch", version: "1.0.0" }));
  await writeFile(join(dir, "README.md"), "scratch\n");
  // .env is untracked in real projects, which is exactly why a fresh
  // worktree has no copy of it and bootstrap has to supply one.
  await writeFile(join(dir, ".gitignore"), ".env\n");
  await writeFile(join(dir, ".env"), "SECRET=shh\n");
  await exec("git", ["add", "-A"], { cwd: dir });
  await exec("git", ["commit", "-q", "-m", "init"], { cwd: dir });
  return dir;
}
