import { describe, it, expect, vi } from "vitest";
import { mkdtemp, mkdir, writeFile, chmod, readdir, readFile } from "node:fs/promises";
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
    // The cockpit draws it on the row, and a restored specialist is still
    // running on whatever it was made with.
    expect(rows[0].model).toBe("opus");
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

/**
 * A stand-in for the CLI. `attach()` always spawns, so without one of these a
 * unit test of the supervisor launches a real agent - and fails as an
 * unhandled ENOENT on any machine that has no CLI installed.
 */
const DYING_CLI = `#!/usr/bin/env node
process.stderr.write("No conversation found with session ID: sess-restore\\n");
process.exit(1);
`;

const REPLYING_CLI = `#!/usr/bin/env node
process.stdout.write(JSON.stringify({ type: "system", subtype: "init" }) + "\\n");
let carry = "";
process.stdin.on("data", (chunk) => {
  carry += chunk.toString();
  const lines = carry.split("\\n");
  carry = lines.pop();
  for (const line of lines) {
    if (line.trim() === "") continue;
    process.stdout.write(JSON.stringify({
      type: "result", subtype: "success", is_error: false,
      session_id: "sess-restore", result: "ok",
    }) + "\\n");
  }
});
`;

async function fakeCli(source: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "bench-fakecli-"));
  const path = join(dir, "fake-claude.mjs");
  await writeFile(path, source);
  await chmod(path, 0o755);
  return path;
}

describe("reviving a specialist after a restart", () => {
  it("does not resume a specialist that has never had a turn", async () => {
    // Created, then the daemon restarted before anyone prompted it. The CLI
    // never wrote a conversation, so `--resume` finds nothing and the process
    // dies on the spot: "No conversation found with session ID".
    const { home, project, worktree, id, reportsDir, config } = await setup();
    const store = new SessionStore(home);
    await store.put({
      id, label: "auth", project, worktree, branch: "bench/auth-abcd1234", reportsDir,
      model: "opus", port: 3101, createdAt: "2026-08-22T00:00:00.000Z",
    });
    const registry = new SessionRegistry(config as any);
    await registry.restore();

    const attach = vi.spyOn(registry as any, "attach").mockImplementation(() => {
      (registry as any).entries.get(id).session = { send() {}, stop() {}, on() {} };
    });
    registry.send(id, "off you go");

    expect(attach).toHaveBeenCalledWith(id, expect.objectContaining({ resume: false }));
  });

  it("records that there is something to resume once a turn has ended", async () => {
    // The half of the fix that has to survive a restart. Without this write
    // the next daemon resumes nothing and the process dies on the spot, which
    // is the bug this whole change is about.
    const { home, project, worktree, id, reportsDir, config } = await setup();
    const store = new SessionStore(home);
    await store.put({
      id, label: "auth", project, worktree, branch: "bench/auth-abcd1234", reportsDir,
      model: "opus", port: 3101, createdAt: "2026-08-22T00:00:00.000Z",
    });
    const registry = new SessionRegistry({
      ...config, claudeBin: await fakeCli(REPLYING_CLI),
    } as any);
    await registry.restore();

    expect((await store.all()).find((r) => r.id === id)?.resumable).toBeUndefined();

    registry.send(id, "off you go");
    await new Promise((r) => setTimeout(r, 600));

    expect((await store.all()).find((r) => r.id === id)?.resumable).toBe(true);
  });

  it("says why the process died rather than only that it did", async () => {
    // The CLI explains itself on stderr before exiting. Reporting a bare
    // "process exited" throws away the one line that would have told the
    // developer what to do about it.
    const { home, project, worktree, id, reportsDir, config } = await setup();
    const store = new SessionStore(home);
    await store.put({
      id, label: "auth", project, worktree, branch: "bench/auth-abcd1234", reportsDir,
      model: "opus", port: 3101, createdAt: "2026-08-22T00:00:00.000Z",
    });
    const registry = new SessionRegistry(config as any);
    await registry.restore();

    const registryWithFake = new SessionRegistry({
      ...config, claudeBin: await fakeCli(DYING_CLI),
    } as any);
    await registryWithFake.restore();

    (registryWithFake as any).attach(id, {
      label: "auth", worktree, model: "opus", port: 3101, resume: false,
    });
    // The real thing dies on its own; waiting for that is the point.
    await new Promise((r) => setTimeout(r, 400));

    const row = registryWithFake.list().find((r) => r.id === id)!;
    expect(row.status).toBe("crashed");
    expect(row.detail).toContain("No conversation found with session ID");
  });

  it("resumes one that has, so it remembers what it was doing", async () => {
    const { home, project, worktree, id, reportsDir, config } = await setup();
    const store = new SessionStore(home);
    await store.put({
      id, label: "auth", project, worktree, branch: "bench/auth-abcd1234", reportsDir,
      model: "opus", port: 3101, createdAt: "2026-08-22T00:00:00.000Z", resumable: true,
    });
    const registry = new SessionRegistry(config as any);
    await registry.restore();

    const attach = vi.spyOn(registry as any, "attach").mockImplementation(() => {
      (registry as any).entries.get(id).session = { send() {}, stop() {}, on() {} };
    });
    registry.send(id, "carry on");

    expect(attach).toHaveBeenCalledWith(id, expect.objectContaining({ resume: true }));
  });
});

/** A specialist created with the worktree toggle off works in the checkout. */
async function setupInPlace() {
  const home = await mkdtemp(join(tmpdir(), "bench-home-"));
  const project = await mkdtemp(join(tmpdir(), "bench-proj-"));
  await exec("git", ["init", "-q", "-b", "main"], { cwd: project });
  await exec("git", ["config", "user.email", "t@t.io"], { cwd: project });
  await exec("git", ["config", "user.name", "t"], { cwd: project });
  await writeFile(join(project, "README.md"), "x");
  await exec("git", ["add", "-A"], { cwd: project });
  await exec("git", ["commit", "-qm", "init"], { cwd: project });

  const id = "sess-inplace";
  const reportsDir = join(project, ".bench", "reports", id);
  await mkdir(reportsDir, { recursive: true });

  const store = new SessionStore(home);
  await store.put({
    id, label: "inplace", project, worktree: project, branch: "main", reportsDir,
    model: "opus", port: 3101, createdAt: "2026-08-22T00:00:00.000Z", isolated: false,
  });

  const registry = new SessionRegistry({
    home, port: 7420, token: "t", pluginDir: "/nonexistent/plugin",
    hookCommand: "node /nonexistent/hook.js", projectsRoot: project,
  } as any);
  await registry.restore();
  return { home, project, id, registry };
}

describe("closing a specialist that works in the checkout itself", () => {
  it("never removes the developer's own worktree or branch", async () => {
    // removeWorktree would run `git worktree remove --force` and `branch -D`
    // against the project itself. There is no worktree to reclaim here, and
    // the branch is the developer's.
    const { project, id, registry } = await setupInPlace();

    const result = await registry.close(id);

    expect(result.closed).toBe(true);
    expect(existsSync(join(project, "README.md"))).toBe(true);
    const branches = await exec("git", ["branch", "--list", "main"], { cwd: project });
    expect(branches.stdout).toContain("main");
  });

  it("closes even with uncommitted work, since closing destroys nothing", async () => {
    const { project, id, registry } = await setupInPlace();
    await writeFile(join(project, "notes.md"), "work in progress");

    const result = await registry.close(id);

    expect(result.closed).toBe(true);
    expect(existsSync(join(project, "notes.md"))).toBe(true);
  });
});

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

describe("answered decisions", () => {
  it("derives what has already been answered from the thread on restore", async () => {
    // A restart must not put an answered question back on the table.
    const { home, project, worktree, id, reportsDir, config } = await setup();
    await mkdir(join(reportsDir, "1"), { recursive: true });
    await writeFile(join(reportsDir, "1", "report.html"), "<h1>done</h1>");
    await writeFile(join(reportsDir, "thread.jsonl"),
      JSON.stringify({ at: "2026-08-22T00:00:00.000Z", kind: "report", body: "Ready", reportSeq: 1 }) + "\n" +
      JSON.stringify({ at: "2026-08-22T00:01:00.000Z", kind: "user", body: "chose proceed" }) + "\n");
    await new SessionStore(home).put({
      id, label: "auth", project, worktree, branch: "bench/auth-abcd1234", reportsDir,
      model: "opus", port: 3101, createdAt: "2026-08-22T00:00:00.000Z",
    });

    const registry = new SessionRegistry(config as any);
    await registry.restore();

    const row = registry.list()[0];
    expect(row.latestReportSeq).toBe(1);
    expect(row.answeredReportSeq).toBe(1);
  });

  it("leaves an unanswered report waiting after a restore", async () => {
    const { home, project, worktree, id, reportsDir, config } = await setup();
    await mkdir(join(reportsDir, "1"), { recursive: true });
    await writeFile(join(reportsDir, "1", "report.html"), "<h1>done</h1>");
    await writeFile(join(reportsDir, "thread.jsonl"),
      JSON.stringify({ at: "2026-08-22T00:00:00.000Z", kind: "report", body: "Ready", reportSeq: 1 }) + "\n");
    await new SessionStore(home).put({
      id, label: "auth", project, worktree, branch: "bench/auth-abcd1234", reportsDir,
      model: "opus", port: 3101, createdAt: "2026-08-22T00:00:00.000Z",
    });

    const registry = new SessionRegistry(config as any);
    await registry.restore();

    expect(registry.list()[0].answeredReportSeq).toBeNull();
  });
});

describe("what a restored specialist may resume", () => {
  it("resumes one that has already spoken, even with no flag on its record", async () => {
    // Records written before resumable was tracked belong to the specialists
    // that have been working longest. Guessing false drops everything they
    // know; the thread already says whether they have taken a turn.
    const { home, project, worktree, id, reportsDir, config } = await setup();
    await writeFile(join(reportsDir, "thread.jsonl"),
      JSON.stringify({ at: "2026-08-22T00:00:00.000Z", kind: "user", body: "do it" }) + "\n" +
      JSON.stringify({ at: "2026-08-22T00:01:00.000Z", kind: "reply", body: "done" }) + "\n");
    await new SessionStore(home).put({
      id, label: "auth", project, worktree, branch: "bench/auth-abcd1234", reportsDir,
      model: "opus", port: 3101, createdAt: "2026-08-22T00:00:00.000Z",
    } as any);

    const registry = new SessionRegistry(config as any);
    await registry.restore();

    expect((registry as any).entries.get(id).resumable).toBe(true);
  });

  it("does not resume one that never took a turn", async () => {
    // Resuming a conversation the CLI never wrote kills the process.
    const { home, project, worktree, id, reportsDir, config } = await setup();
    await new SessionStore(home).put({
      id, label: "auth", project, worktree, branch: "bench/auth-abcd1234", reportsDir,
      model: "opus", port: 3101, createdAt: "2026-08-22T00:00:00.000Z",
    } as any);

    const registry = new SessionRegistry(config as any);
    await registry.restore();

    expect((registry as any).entries.get(id).resumable).toBe(false);
  });

  it("believes the record when it says so", async () => {
    const { home, project, worktree, id, reportsDir, config } = await setup();
    await new SessionStore(home).put({
      id, label: "auth", project, worktree, branch: "bench/auth-abcd1234", reportsDir,
      model: "opus", port: 3101, createdAt: "2026-08-22T00:00:00.000Z", resumable: true,
    } as any);

    const registry = new SessionRegistry(config as any);
    await registry.restore();

    expect((registry as any).entries.get(id).resumable).toBe(true);
  });
});

describe("a revived specialist's turn numbering", () => {
  it("carries on from the turns already on disk", async () => {
    // Starting again at one overwrote every earlier report, and left the
    // roster pointing at a stale higher-numbered directory.
    const { home, project, worktree, id, reportsDir, config } = await setup();
    for (const turn of [1, 2, 3]) {
      await mkdir(join(reportsDir, String(turn)), { recursive: true });
      await writeFile(join(reportsDir, String(turn), "report.html"), `<h1>turn ${turn}</h1>`);
    }
    await new SessionStore(home).put({
      id, label: "auth", project, worktree, branch: "bench/auth-abcd1234", reportsDir,
      model: "opus", port: 3101, createdAt: "2026-08-22T00:00:00.000Z",
    } as any);

    const registry = new SessionRegistry(config as any);
    await registry.restore();

    expect((registry as any).entries.get(id).turnsTaken).toBe(3);
  });

  it("starts at nothing for a specialist that has taken no turns", async () => {
    const { home, project, worktree, id, reportsDir, config } = await setup();
    await new SessionStore(home).put({
      id, label: "auth", project, worktree, branch: "bench/auth-abcd1234", reportsDir,
      model: "opus", port: 3101, createdAt: "2026-08-22T00:00:00.000Z",
    } as any);

    const registry = new SessionRegistry(config as any);
    await registry.restore();

    expect((registry as any).entries.get(id).turnsTaken).toBe(0);
  });
});

describe("what kind of agent a tab holds", () => {
  it("calls everything already on disk a specialist", async () => {
    // Every record written before roles existed has no role, and every one of
    // them was a specialist. Guessing anything else rewrites history.
    const { home, project, worktree, id, reportsDir, config } = await setup();
    await new SessionStore(home).put({
      id, label: "auth", project, worktree, branch: "bench/auth-abcd1234", reportsDir, model: "opus",
      port: 3101, createdAt: "2026-08-22T00:00:00.000Z",
    });

    const registry = new SessionRegistry(config as any);
    await registry.restore();

    expect(registry.list()[0].role).toBe("specialist");
  });

  it("keeps the role it was opened with", async () => {
    const { home, project, worktree, id, reportsDir, config } = await setup();
    await new SessionStore(home).put({
      id, label: "auth", role: "reviewer", project, worktree,
      branch: "bench/auth-abcd1234", reportsDir, model: "opus",
      port: 3101, createdAt: "2026-08-22T00:00:00.000Z",
    });

    const registry = new SessionRegistry(config as any);
    await registry.restore();

    expect(registry.list()[0].role).toBe("reviewer");
  });

  it("refuses a role nobody defined rather than showing it", async () => {
    // The role reaches the daemon as a string off an HTTP body.
    const { home, project, worktree, id, reportsDir, config } = await setup();
    await new SessionStore(home).put({
      id, label: "auth", role: "supervisor", project, worktree,
      branch: "bench/auth-abcd1234", reportsDir, model: "opus",
      port: 3101, createdAt: "2026-08-22T00:00:00.000Z",
    });

    const registry = new SessionRegistry(config as any);
    await registry.restore();

    expect(registry.list()[0].role).toBe("specialist");
  });
});

describe("where a specialist is working", () => {
  it("carries the branch and the isolation onto the roster", async () => {
    const { home, project, worktree, id, reportsDir, config } = await setup();
    await new SessionStore(home).put({
      id, label: "quick-look", project, worktree, branch: "main", reportsDir, model: "opus",
      port: 3101, createdAt: "2026-08-22T00:00:00.000Z", isolated: false,
    });

    const registry = new SessionRegistry(config as any);
    await registry.restore();

    expect(registry.list()[0].branch).toBe("main");
    expect(registry.list()[0].isolated).toBe(false);
  });

  it("calls a record from before the toggle isolated, because they all were", async () => {
    const { home, project, worktree, id, reportsDir, config } = await setup();
    await new SessionStore(home).put({
      id, label: "auth", project, worktree, branch: "bench/auth-abcd1234", reportsDir,
      model: "opus", port: 3101, createdAt: "2026-08-22T00:00:00.000Z",
    });

    const registry = new SessionRegistry(config as any);
    await registry.restore();

    expect(registry.list()[0].isolated).toBe(true);
  });
});

describe("a specialist whose process has gone", () => {
  it("lets go of the dead session, so the next prompt revives it", async () => {
    // Holding the reference meant the next message took the "already running"
    // path and threw - and a throw in a request handler ended the daemon.
    const { home, project, worktree, id, reportsDir, config } = await setup();
    const bin = join(await mkdtemp(join(tmpdir(), "bench-fake-")), "cli.mjs");
    await writeFile(bin, "process.stdin.on('data', () => {});\nsetInterval(() => {}, 1000);\n");

    await new SessionStore(home).put({
      id, label: "auth", project, worktree, branch: "bench/auth-abcd1234", reportsDir,
      model: "opus", port: 3101, createdAt: "2026-08-23T00:00:00.000Z",
    } as any);

    const registry = new SessionRegistry({ ...config, claudeBin: "node" } as any);
    await registry.restore();

    // The real wiring, so the real exit handler runs.
    const entry = (registry as any).entries.get(id);
    (registry as any).attach(id, {
      label: "auth", worktree, model: "opus", port: 3101, startTurn: 0,
    });
    expect(entry.session).not.toBeNull();

    registry.stop(id);
    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(entry.session).toBeNull();
    expect(entry.alive).toBe(false);
  });
});

describe("the developer's own API key", () => {
  const KEY = "sk-ant-api03-typed-into-the-cockpit-4f2a";

  it("is nothing at all until one is set", async () => {
    const { config } = await setup();

    expect(new SessionRegistry(config as any).apiKeyState()).toEqual({ present: false, hint: "", enabled: true });
  });

  it("shows only its last four characters once set", async () => {
    const { config } = await setup();
    const registry = new SessionRegistry(config as any);

    registry.setApiKey(KEY);

    expect(registry.apiKeyState()).toEqual({ present: true, hint: "…4f2a", enabled: true });
    expect(registry.getApiKey()).toBe(KEY);
  });

  it("goes back to nothing when it is cleared", async () => {
    const { config } = await setup();
    const registry = new SessionRegistry(config as any);
    registry.setApiKey(KEY);

    registry.clearApiKey();

    expect(registry.apiKeyState()).toEqual({ present: false, hint: "", enabled: true });
    expect(registry.getApiKey()).toBeNull();
  });

  it("is in use the moment it is set", async () => {
    const { config } = await setup();
    const registry = new SessionRegistry(config as any);

    registry.setApiKey(KEY);

    expect(registry.apiKeyState().enabled).toBe(true);
  });

  it("stops being handed out while it is switched off, without being forgotten", async () => {
    // Parked, not removed. A developer switching between their own key and
    // the machine's login should not have to paste the key again each time.
    const { config } = await setup();
    const registry = new SessionRegistry(config as any);
    registry.setApiKey(KEY);

    registry.setApiKeyEnabled(false);

    expect(registry.getApiKey()).toBeNull();
    expect(registry.apiKeyState()).toEqual({ present: true, hint: "…4f2a", enabled: false });
  });

  it("hands it out again when it is switched back on", async () => {
    const { config } = await setup();
    const registry = new SessionRegistry(config as any);
    registry.setApiKey(KEY);
    registry.setApiKeyEnabled(false);

    registry.setApiKeyEnabled(true);

    expect(registry.getApiKey()).toBe(KEY);
  });

  it("takes a newly saved key as one to use, whatever the last one was", async () => {
    // Saving a key is asking for it to be used. Inheriting "off" from a key
    // that is gone would be a key that silently does nothing.
    const { config } = await setup();
    const registry = new SessionRegistry(config as any);
    registry.setApiKey(KEY);
    registry.setApiKeyEnabled(false);

    registry.setApiKey("sk-ant-api03-another-key-9c1d");

    expect(registry.apiKeyState().enabled).toBe(true);
    expect(registry.getApiKey()).toBe("sk-ant-api03-another-key-9c1d");
  });

  it("is switched on again once a parked key is thrown away", async () => {
    const { config } = await setup();
    const registry = new SessionRegistry(config as any);
    registry.setApiKey(KEY);
    registry.setApiKeyEnabled(false);

    registry.clearApiKey();

    expect(registry.apiKeyState()).toEqual({ present: false, hint: "", enabled: true });
  });

  it("is forgotten when the daemon restarts", async () => {
    // Session-only, deliberately. A key kept in a file is one you forget you
    // set, and the bench it overrides already has a working login.
    const { home, config } = await setup();
    new SessionRegistry(config as any).setApiKey(KEY);

    const restarted = new SessionRegistry(config as any);
    await restarted.restore();

    expect(restarted.apiKeyState().present).toBe(false);
    for (const file of await readdir(home)) {
      expect(await readFile(join(home, file), "utf8")).not.toContain(KEY);
    }
  });
});
