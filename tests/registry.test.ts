import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionRegistry } from "../src/daemon/registry.js";
import { SessionStore } from "../src/daemon/store.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

async function setup() {
  const home = await mkdtemp(join(tmpdir(), "bench-home-"));
  const project = await mkdtemp(join(tmpdir(), "bench-proj-"));
  const worktree = join(project, ".claude", "worktrees", "auth");
  await mkdir(worktree, { recursive: true });

  const id = "sess-restore";
  const reportsDir = join(project, ".bench", "reports", id);
  await mkdir(reportsDir, { recursive: true });

  const config = {
    home,
    port: 7420,
    token: "t",
    pluginDir: "/nonexistent/plugin",
    hookCommand: "node /nonexistent/hook.js",
    projectsRoot: project,
  };

  return { home, project, worktree, id, reportsDir, config };
}

describe("SessionRegistry.restore", () => {
  it("brings the roster back after the daemon has restarted", async () => {
    const { home, project, worktree, id, reportsDir, config } = await setup();
    await new SessionStore(home).put({
      id, label: "auth", project, worktree, branch: "bench/auth-abcd1234", reportsDir, model: "opus",
      port: 3101, createdAt: "2026-08-22T00:00:00.000Z",
    });

    const registry = new SessionRegistry(config as any);
    await registry.restore();

    const rows = registry.list();
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(id);
    expect(rows[0].label).toBe("auth");
    expect(rows[0].detail).toBe("ready");
  });

  it("spawns nothing until the specialist is prompted", async () => {
    const { home, project, worktree, id, reportsDir, config } = await setup();
    await new SessionStore(home).put({
      id, label: "auth", project, worktree, branch: "bench/auth-abcd1234", reportsDir, model: "opus",
      port: 3101, createdAt: "2026-08-22T00:00:00.000Z",
    });

    const registry = new SessionRegistry(config as any);
    await registry.restore();

    // Restored but cold: no process, so opening the cockpit costs nothing.
    expect(registry.get(id)?.alive).toBe(false);
  });

  it("carries a report written before the restart back onto the roster", async () => {
    const { home, project, worktree, id, reportsDir, config } = await setup();
    await mkdir(join(reportsDir, "1"), { recursive: true });
    await writeFile(join(reportsDir, "1", "report.html"), "<h1>done</h1>");
    await new SessionStore(home).put({
      id, label: "auth", project, worktree, branch: "bench/auth-abcd1234", reportsDir, model: "opus",
      port: 3101, createdAt: "2026-08-22T00:00:00.000Z",
    });

    const registry = new SessionRegistry(config as any);
    await registry.restore();

    expect(registry.list()[0].latestReportSeq).toBe(1);
  });

  it("says so when the worktree has been removed", async () => {
    const { home, project, id, reportsDir, config } = await setup();
    await new SessionStore(home).put({
      id, label: "auth", project, worktree: join(project, "gone"), branch: "bench/auth-abcd1234",
      reportsDir, model: "opus", port: 3101, createdAt: "2026-08-22T00:00:00.000Z",
    });

    const registry = new SessionRegistry(config as any);
    await registry.restore();

    const row = registry.list()[0];
    expect(row.status).toBe("crashed");
    expect(row.detail).toMatch(/worktree/i);
  });

  it("does not try to revive a specialist whose worktree is gone", async () => {
    const { home, project, id, reportsDir, config } = await setup();
    await new SessionStore(home).put({
      id, label: "auth", project, worktree: join(project, "gone"), branch: "bench/auth-abcd1234",
      reportsDir, model: "opus", port: 3101, createdAt: "2026-08-22T00:00:00.000Z",
    });

    const registry = new SessionRegistry(config as any);
    await registry.restore();
    registry.send(id, "carry on");

    expect(registry.get(id)?.alive).toBe(false);
    expect(registry.list()[0].detail).toMatch(/worktree/i);
  });

  it("reports a cold specialist as revivable, not dead", async () => {
    // The server refuses messages to a dead process. A restored specialist
    // has no process yet on purpose, and must not be mistaken for one.
    const { home, project, worktree, id, reportsDir, config } = await setup();
    await new SessionStore(home).put({
      id, label: "auth", project, worktree, branch: "bench/auth-abcd1234", reportsDir, model: "opus",
      port: 3101, createdAt: "2026-08-22T00:00:00.000Z",
    });

    const registry = new SessionRegistry(config as any);
    await registry.restore();

    expect(registry.get(id)?.alive).toBe(false);
    expect(registry.get(id)?.revivable).toBe(true);
  });

  it("is not revivable once the worktree has gone", async () => {
    const { home, project, id, reportsDir, config } = await setup();
    await new SessionStore(home).put({
      id, label: "auth", project, worktree: join(project, "gone"), branch: "bench/auth-abcd1234",
      reportsDir, model: "opus", port: 3101, createdAt: "2026-08-22T00:00:00.000Z",
    });

    const registry = new SessionRegistry(config as any);
    await registry.restore();

    expect(registry.get(id)?.revivable).toBe(false);
  });

  it("starts empty when nothing has been persisted", async () => {
    const { config } = await setup();
    const registry = new SessionRegistry(config as any);
    await registry.restore();
    expect(registry.list()).toEqual([]);
  });
});

/** A real repo with a real worktree, since closing one is a git operation. */
async function setupReal(label = "auth") {
  const home = await mkdtemp(join(tmpdir(), "bench-home-"));
  const project = await mkdtemp(join(tmpdir(), "bench-proj-"));
  await exec("git", ["init", "-q", "-b", "main"], { cwd: project });
  await exec("git", ["config", "user.email", "t@t.io"], { cwd: project });
  await exec("git", ["config", "user.name", "t"], { cwd: project });
  await writeFile(join(project, "README.md"), "x");
  await exec("git", ["add", "-A"], { cwd: project });
  await exec("git", ["commit", "-qm", "init"], { cwd: project });

  const worktree = join(project, ".claude", "worktrees", `${label}-abcd1234`);
  const branch = `bench/${label}-abcd1234`;
  await mkdir(join(project, ".claude", "worktrees"), { recursive: true });
  await exec("git", ["worktree", "add", "-q", "-b", branch, worktree], { cwd: project });

  const id = "sess-close";
  const reportsDir = join(project, ".bench", "reports", id);
  await mkdir(reportsDir, { recursive: true });

  const config = {
    home, port: 7420, token: "t",
    pluginDir: "/nonexistent/plugin",
    hookCommand: "node /nonexistent/hook.js",
    projectsRoot: project,
  };

  const store = new SessionStore(home);
  await store.put({
    id, label, project, worktree, branch, reportsDir, model: "opus",
    port: 3101, createdAt: "2026-08-22T00:00:00.000Z",
  });

  const registry = new SessionRegistry(config as any);
  await registry.restore();
  return { home, project, worktree, branch, id, reportsDir, store, registry };
}

describe("SessionRegistry.close", () => {
  it("removes the specialist so a restart cannot bring it back", async () => {
    const { home, id, registry } = await setupReal();

    const result = await registry.close(id);
    expect(result.closed).toBe(true);
    expect(registry.list()).toEqual([]);

    // The next daemon reads the store, so this is what "won't come back" means.
    const next = new SessionRegistry({ home } as any);
    await next.restore();
    expect(next.list()).toEqual([]);
  });

  it("removes the worktree and its branch", async () => {
    const { project, worktree, branch, id, registry } = await setupReal();

    await registry.close(id);

    const { stdout } = await exec("git", ["worktree", "list"], { cwd: project });
    expect(stdout).not.toContain(worktree);
    const branches = await exec("git", ["branch", "--list", branch], { cwd: project });
    expect(branches.stdout.trim()).toBe("");
  });

  it("refuses to close over uncommitted work", async () => {
    const { worktree, id, registry, home } = await setupReal();
    await writeFile(join(worktree, "notes.md"), "a spec nobody committed");

    const result = await registry.close(id);
    expect(result.closed).toBe(false);
    expect(result.changes).toBe(1);

    // Still there, and still there after a restart.
    expect(registry.list()).toHaveLength(1);
    const next = new SessionRegistry({ home } as any);
    await next.restore();
    expect(next.list()).toHaveLength(1);
  });

  it("keeps the worktree when it refuses", async () => {
    const { worktree, id, registry } = await setupReal();
    await writeFile(join(worktree, "notes.md"), "work in progress");

    await registry.close(id);
    expect(existsSync(join(worktree, "notes.md"))).toBe(true);
  });

  it("closes anyway when forced", async () => {
    const { worktree, id, registry } = await setupReal();
    await writeFile(join(worktree, "notes.md"), "throwaway");

    const result = await registry.close(id, { force: true });
    expect(result.closed).toBe(true);
    expect(registry.list()).toEqual([]);
    expect(existsSync(worktree)).toBe(false);
  });

  it("keeps the thread and reports, which are the record of what happened", async () => {
    const { reportsDir, id, registry } = await setupReal();
    await writeFile(join(reportsDir, "thread.jsonl"), "{}\n");

    await registry.close(id);
    expect(existsSync(join(reportsDir, "thread.jsonl"))).toBe(true);
  });

  it("is a no-op for a specialist that does not exist", async () => {
    const { registry } = await setupReal();
    const result = await registry.close("nope");
    expect(result.closed).toBe(false);
  });
});

describe("branch identity", () => {
  it("deletes the branch that was recorded, not one guessed from the label", async () => {
    // Two specialists can share a label now, so a branch name derived from
    // the label could belong to somebody else.
    const { project, branch, id, registry } = await setupReal("shared");

    await registry.close(id);

    const { stdout } = await exec("git", ["branch", "--list", branch], { cwd: project });
    expect(stdout.trim()).toBe("");
  });
});
