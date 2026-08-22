import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionRegistry } from "../src/daemon/registry.js";
import { SessionStore } from "../src/daemon/store.js";

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
      id, label: "auth", project, worktree, reportsDir, model: "opus",
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
      id, label: "auth", project, worktree, reportsDir, model: "opus",
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
      id, label: "auth", project, worktree, reportsDir, model: "opus",
      port: 3101, createdAt: "2026-08-22T00:00:00.000Z",
    });

    const registry = new SessionRegistry(config as any);
    await registry.restore();

    expect(registry.list()[0].latestReportSeq).toBe(1);
  });

  it("says so when the worktree has been removed", async () => {
    const { home, project, id, reportsDir, config } = await setup();
    await new SessionStore(home).put({
      id, label: "auth", project, worktree: join(project, "gone"), reportsDir,
      model: "opus", port: 3101, createdAt: "2026-08-22T00:00:00.000Z",
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
      id, label: "auth", project, worktree: join(project, "gone"), reportsDir,
      model: "opus", port: 3101, createdAt: "2026-08-22T00:00:00.000Z",
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
      id, label: "auth", project, worktree, reportsDir, model: "opus",
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
      id, label: "auth", project, worktree: join(project, "gone"), reportsDir,
      model: "opus", port: 3101, createdAt: "2026-08-22T00:00:00.000Z",
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
