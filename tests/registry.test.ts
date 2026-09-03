import { describe, it, expect, vi } from "vitest";
import { mkdtemp, mkdir, writeFile, chmod, readdir, readFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readParked } from "../src/daemon/key-park.js";
import { waitFor } from "./helpers/wait-for.js";
import { SessionRegistry } from "../src/daemon/registry.js";
import { SessionStore } from "../src/daemon/store.js";
import { Ledger } from "../src/daemon/ledger.js";
import { readThread } from "../src/daemon/thread.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);
import { RECENT_COSTS } from "../src/daemon/gemini.js";

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

  it("brings back who opened a tab, so the roster still nests after a restart", async () => {
    // A tab another specialist opened with `bench new` draws nested under it,
    // and the nesting hangs off `createdBy`. It used to be held in memory
    // only: a daemon restart wrote `null` against every row and the whole
    // hierarchy collapsed to the top level. The opener is a structural fact
    // about the roster, not the transient pre-dispatch state it shared a
    // field with, so it has to come back off the disk.
    const { home, project, worktree, id, reportsDir, config } = await setup();
    await new SessionStore(home).put({
      id, label: "child", project, worktree, branch: "bench/child-abcd1234", reportsDir, model: "opus",
      port: 3101, createdAt: "2026-08-22T00:00:00.000Z", createdBy: "sess-parent",
    });

    const registry = new SessionRegistry(config as any);
    await registry.restore();

    expect(registry.list()[0].createdBy).toBe("sess-parent");
  });

  it("leaves a tab the developer opened at the top level after a restart", async () => {
    // Absent on a record written before the field existed, or for a tab nobody
    // but the developer made: nothing to nest under, so it is a root.
    const { home, project, worktree, id, reportsDir, config } = await setup();
    await new SessionStore(home).put({
      id, label: "solo", project, worktree, branch: "bench/solo-abcd1234", reportsDir, model: "opus",
      port: 3101, createdAt: "2026-08-22T00:00:00.000Z",
    });

    const registry = new SessionRegistry(config as any);
    await registry.restore();

    expect(registry.list()[0].createdBy).toBeNull();
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

const COLLIDING_CLI = `#!/usr/bin/env node
process.stderr.write("Error: Session ID sess-restore is already in use\\n");
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

/** Says back the credential the specialist was actually spawned with. */
const CREDENTIAL_CLI = `#!/usr/bin/env node
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
      session_id: "sess-restore",
      result: "key:" + (process.env.ANTHROPIC_API_KEY ?? "none"),
    }) + "\\n");
  }
});
`;

/** Writes a report before answering, the way a specialist does when a turn
 * ends in a decision rather than a plain reply. Reads the turn number `.turn`
 * the same way the real CLI's artifact directory is chosen, so it lands where
 * `findReport` actually looks. */
const REPORTING_CLI = `#!/usr/bin/env node
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
process.stdout.write(JSON.stringify({ type: "system", subtype: "init" }) + "\\n");
let carry = "";
process.stdin.on("data", (chunk) => {
  carry += chunk.toString();
  const lines = carry.split("\\n");
  carry = lines.pop();
  for (const line of lines) {
    if (line.trim() === "") continue;
    const reportsDir = process.env.BENCH_REPORTS_DIR;
    const turn = readFileSync(join(reportsDir, ".turn"), "utf8").trim();
    const dir = join(reportsDir, turn);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "report.html"), "<h1>done</h1>");
    writeFileSync(join(dir, "decision.json"), JSON.stringify({
      kind: "question", title: "Done", summary: "x", options: [], questions: [], allowFreeText: true,
    }));
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
    await waitFor(
      async () => ((await store.all()).find((r) => r.id === id)?.resumable === true ? true : null),
      "resumable to be written to disk",
    );

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
    await waitFor(
      () => (registryWithFake.list().find((r) => r.id === id)?.status === "crashed" ? true : null),
      "the process to die",
    );

    const row = registryWithFake.list().find((r) => r.id === id)!;
    expect(row.status).toBe("crashed");
    expect(row.detail).toContain("No conversation found with session ID");
  });

  it("believes the CLI's own collision refusal, so a crash before the first turn does not repeat forever", async () => {
    // A process can die before finishing its first turn for reasons that have
    // nothing to do with resuming - but the CLI has already claimed the id on
    // disk, so `--session-id` collides on every retry and `resumable` never
    // gets the chance to flip the normal way (a completed turn). Without this,
    // the tab is crashed for good; the developer's only way out was deleting
    // the orphaned session file by hand.
    const { home, project, worktree, id, reportsDir, config } = await setup();
    const store = new SessionStore(home);
    await store.put({
      id, label: "auth", project, worktree, branch: "bench/auth-abcd1234", reportsDir,
      model: "opus", port: 3101, createdAt: "2026-08-22T00:00:00.000Z",
    });
    const registry = new SessionRegistry({
      ...config, claudeBin: await fakeCli(COLLIDING_CLI),
    } as any);
    await registry.restore();

    (registry as any).attach(id, {
      label: "auth", worktree, model: "opus", port: 3101, resume: false,
    });
    await waitFor(
      () => (registry.list().find((r) => r.id === id)?.status === "crashed" ? true : null),
      "the collision to crash it",
    );

    const row = registry.list().find((r) => r.id === id)!;
    expect(row.status).toBe("crashed");
    expect((registry as any).entries.get(id).resumable).toBe(true);
    await waitFor(
      async () => ((await store.all()).find((r) => r.id === id)?.resumable === true ? true : null),
      "resumable to be written to disk",
    );
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

/** A CLI that finishes a turn having cost something, so there is a bill. */
const BILLING_CLI = `#!/usr/bin/env node
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
      session_id: "sess-close", result: "done",
      total_cost_usd: 6.44,
      usage: {
        input_tokens: 600, cache_creation_input_tokens: 4000,
        cache_read_input_tokens: 260000, output_tokens: 3000,
      },
    }) + "\\n");
  }
});
`;

describe("what a turn cost, after the tab is gone", () => {
  it("keeps the spend in the ledger when the specialist is closed", async () => {
    // Closing is the ordinary end of a specialist's life, and it removes the
    // record the spend used to live on - so using Bench normally meant
    // spending money and then erasing the fact. Seven closed tabs on this
    // developer's own machine had already taken their spend with them.
    const { home, id } = await setupReal();
    const registry = new SessionRegistry({
      home, port: 7420, token: "t",
      pluginDir: "/nonexistent/plugin", hookCommand: "node /nonexistent/hook.js",
      claudeBin: await fakeCli(BILLING_CLI),
    } as any);
    await registry.restore();

    registry.send(id, "off you go");
    await waitFor(() => registry.list()[0]?.spend?.dollars === 6.44);

    expect((await registry.close(id)).closed).toBe(true);
    expect(registry.list()).toEqual([]);

    const total = await new Ledger(home).total();
    expect(total.plan).toBeCloseTo(6.44);
    expect(total.turns).toBe(1);
    // An Anthropic turn is priced by the CLI from Anthropic's own table, which
    // is the one case where that figure is right.
    expect((await new Ledger(home).all())[0]!.basis).toBe("settled");
  });

  it("names the specialist in the ledger, since a closed tab has no other name", async () => {
    const { home, id } = await setupReal();
    const registry = new SessionRegistry({
      home, port: 7420, token: "t",
      pluginDir: "/nonexistent/plugin", hookCommand: "node /nonexistent/hook.js",
      claudeBin: await fakeCli(BILLING_CLI),
    } as any);
    await registry.restore();

    registry.send(id, "off you go");
    await waitFor(() => registry.list()[0]?.spend !== null);
    await registry.close(id);

    const [entry] = await new Ledger(home).all();
    expect(entry!.label).toBe("auth");
    expect(entry!.model).toBe("opus");
    expect(entry!.session).toBe(id);
  });
});

/**
 * A CLI answered by OpenRouter: every request it makes leaves a generation id
 * behind on its assistant events, which is the only handle on what it cost.
 */
const PROXIED_CLI = (model: string, ids: string[]) => `#!/usr/bin/env node
process.stdout.write(JSON.stringify({ type: "system", subtype: "init" }) + "\\n");
let carry = "";
process.stdin.on("data", (chunk) => {
  carry += chunk.toString();
  const lines = carry.split("\\n");
  carry = lines.pop();
  for (const line of lines) {
    if (line.trim() === "") continue;
    for (const id of ${JSON.stringify(ids)}) {
      // Two events per request, both carrying its one id, as the real CLI does.
      for (let i = 0; i < 2; i++) {
        process.stdout.write(JSON.stringify({
          type: "assistant", request_id: id,
          message: { id, model: ${JSON.stringify(model)}, content: [{ type: "text", text: "x" }] },
        }) + "\\n");
      }
    }
    process.stdout.write(JSON.stringify({
      type: "result", subtype: "success", is_error: false,
      session_id: "sess-close", result: "done",
      usage: { input_tokens: 100, cache_creation_input_tokens: 0,
               cache_read_input_tokens: 200000, output_tokens: 500 },
    }) + "\\n");
  }
});
`;

/** A CLI that starts a turn, says it is working, and never finishes. */
const HANGING_CLI = (model: string, id: string) => `#!/usr/bin/env node
process.stdout.write(JSON.stringify({ type: "system", subtype: "init" }) + "\\n");
let carry = "";
process.stdin.on("data", (chunk) => {
  carry += chunk.toString();
  const lines = carry.split("\\n");
  carry = lines.pop();
  for (const line of lines) {
    if (line.trim() === "") continue;
    // A tool call rather than prose, so the roster records activity and the
    // test can tell the request has actually been made before it stops it.
    process.stdout.write(JSON.stringify({
      type: "assistant", request_id: ${JSON.stringify(id)},
      message: { id: ${JSON.stringify(id)}, model: ${JSON.stringify(model)},
                 content: [{ type: "tool_use", name: "Bash", input: { command: "sleep 60" } }] },
    }) + "\\n");
  }
});
setInterval(() => {}, 1000);
`;

/** OpenRouter, as far as the daemon can tell. Prices every generation the same
 * and serves a catalogue cheap enough that an estimate could never reach it. */
function fakeOpenRouter(perGeneration: number) {
  return async (input: any) => {
    const url = String(input);
    if (url.includes("/generation")) {
      return new Response(JSON.stringify({ data: { total_cost: perGeneration } }), { status: 200 });
    }
    if (url.includes("/models")) {
      return new Response(JSON.stringify({
        data: [{
          id: "deepseek/deepseek-v4-pro", name: "DeepSeek Pro", context_length: 200000,
          supported_parameters: ["tools"],
          pricing: { prompt: "0.00000087", completion: "0.00000174", input_cache_read: "0.0000000725" },
        }],
      }), { status: 200 });
    }
    return new Response("{}", { status: 404 });
  };
}

describe("what an OpenRouter turn really cost", () => {
  async function billedTurns(home: string, count = 1) {
    return waitFor(async () => {
      const all = await new Ledger(home).all();
      return all.length >= count ? all : null;
    }, `${count} billed turn(s)`);
  }

  async function proxied(model: string, cli: string) {
    const { home, id } = await setupReal();
    await new SessionStore(home).remodel(id, model);
    const registry = new SessionRegistry({
      home, port: 7420, token: "t",
      pluginDir: "/nonexistent/plugin", hookCommand: "node /nonexistent/hook.js",
      claudeBin: await fakeCli(cli),
    } as any);
    await registry.restore();
    registry.setRouterKey("sk-or-test");
    return { home, id, registry };
  }

  it("bills what OpenRouter charged, not what the catalogue quotes", async () => {
    // The catalogue quotes one provider and OpenRouter bills whichever one
    // served the request. Over 500 of this developer's real requests that gap
    // came to $7.02 quoted against $10.24 charged, so the estimate is a
    // fallback now rather than the answer.
    vi.stubGlobal("fetch", fakeOpenRouter(0.25));
    const { home, id, registry } = await proxied(
      "deepseek/deepseek-v4-pro", PROXIED_CLI("deepseek/deepseek-v4-pro", ["gen-a", "gen-b"]),
    );

    RECENT_COSTS.set("gen-a", 0.25);
    RECENT_COSTS.set("gen-b", 0.25);
    registry.send(id, "off you go");
    const [entry] = await billedTurns(home);
    // Two requests at 25c, counted once each however many events repeated them.
    expect(entry!.dollars).toBeCloseTo(0.5);
    expect(entry!.basis).toBe("settled");
    expect(entry!.billed).toBe("account");
    vi.unstubAllGlobals();
  });

  it("bills a turn the router answered, which used to record nothing at all", async () => {
    // OpenRouter quotes `openrouter/auto` as a negative sentinel, so the
    // estimate was null and `bill` returned before touching anything - not the
    // dollars and not even the turn counter. The id does not care what was
    // asked for, so these can be priced like any other.
    vi.stubGlobal("fetch", fakeOpenRouter(0.1));
    const { home, id, registry } = await proxied(
      "openrouter/auto", PROXIED_CLI("deepseek/deepseek-v4-pro", ["gen-c"]),
    );

    RECENT_COSTS.set("gen-c", 0.1);
    registry.send(id, "off you go");
    const [entry] = await billedTurns(home);
    expect(entry!.dollars).toBeCloseTo(0.1);
    expect(entry!.basis).toBe("settled");
    // The only record anywhere of what the router actually picked.
    expect(entry!.served).toEqual(["deepseek/deepseek-v4-pro"]);
    vi.unstubAllGlobals();
  });

  it("bills a turn that was stopped before it finished", async () => {
    // Stop, remodel, change role and clear-context all kill the process
    // mid-turn, and billing hangs off a result event that never arrives. The
    // requests were made and charged all the same.
    vi.stubGlobal("fetch", fakeOpenRouter(0.4));
    const { home, id, registry } = await proxied(
      "deepseek/deepseek-v4-pro", HANGING_CLI("deepseek/deepseek-v4-pro", "gen-d"),
    );

    RECENT_COSTS.set("gen-d", 0.4);
    registry.send(id, "off you go");
    // The row reads "working" the moment it is prompted, so waiting on that
    // would stop the specialist before it had made a request to be billed for.
    // Activity only appears once the CLI has actually answered.
    await waitFor(() => registry.list()[0]?.activity.length > 0);
    registry.stop(id);
    const [entry] = await billedTurns(home);
    expect(entry!.dollars).toBeCloseTo(0.4);
    expect(entry!.billed).toBe("account");
    vi.unstubAllGlobals();
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
    await waitFor(() => (entry.session === null ? true : null), "the session to be released after stop");

    expect(entry.session).toBeNull();
    expect(entry.alive).toBe(false);
  });
});

describe("the developer's own API key", () => {
  const KEY = "sk-ant-api03-typed-into-the-cockpit-4f2a";

  it("is nothing at all until one is set", async () => {
    const { config } = await setup();

    expect(new SessionRegistry(config as any).apiKeyState()).toEqual({ present: false, hint: "", enabled: true, origin: "", searched: [] });
  });

  /**
   * A key nobody typed defaults to off. Bench finding one in the environment
   * is not the developer choosing to spend it - that choice happens in
   * Settings, and until it does specialists keep using this machine's own
   * login.
   */
  it("starts switched off when it is only found, never typed", async () => {
    const { config } = await setup();
    const registry = new SessionRegistry({
      ...config,
      credentials: {
        anthropic: { key: KEY, origin: { from: "file", name: "ANTHROPIC_API_KEY", path: "/w/.env" } },
        router: null,
        searched: ["/w/.env"],
      },
    } as any);

    expect(registry.apiKeyState()).toEqual({
      present: true, hint: "…4f2a", enabled: false,
      origin: "from ANTHROPIC_API_KEY in /w/.env", searched: ["/w/.env"],
    });
    expect(registry.getApiKey()).toBeNull();
  });

  it("is in use the moment it is typed in, unlike one only found", async () => {
    const { config } = await setup();
    const registry = new SessionRegistry({
      ...config,
      credentials: {
        anthropic: { key: "sk-ant-api03-found-in-the-env-0000", origin: { from: "file", name: "ANTHROPIC_API_KEY", path: "/w/.env" } },
        router: null,
        searched: ["/w/.env"],
      },
    } as any);
    expect(registry.getApiKey()).toBeNull();

    registry.setApiKey(KEY);

    expect(registry.apiKeyState().enabled).toBe(true);
    expect(registry.getApiKey()).toBe(KEY);
  });

  it("shows only its last four characters once set", async () => {
    const { config } = await setup();
    const registry = new SessionRegistry(config as any);

    registry.setApiKey(KEY);

    expect(registry.apiKeyState()).toEqual({ present: true, hint: "…4f2a", enabled: true, origin: "typed here", searched: [] });
    expect(registry.getApiKey()).toBe(KEY);
  });

  it("goes back to nothing when it is cleared", async () => {
    const { config } = await setup();
    const registry = new SessionRegistry(config as any);
    registry.setApiKey(KEY);

    registry.clearApiKey();

    expect(registry.apiKeyState()).toEqual({ present: false, hint: "", enabled: true, origin: "", searched: [] });
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
    expect(registry.apiKeyState()).toEqual({ present: true, hint: "…4f2a", enabled: false, origin: "typed here", searched: [] });
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

    expect(registry.apiKeyState()).toEqual({ present: false, hint: "", enabled: true, origin: "", searched: [] });
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

  /**
   * What the toggle is for.
   *
   * Parking the key is how a developer says "bill this to the subscription
   * this machine is already logged in as, not to my key" - so it has to
   * reach the process. It did not: the spawn read the key straight off the
   * field and went around the switch, which made the toggle a control that
   * moved and changed nothing.
   */
  describe("reaching the specialist it is spawned for", () => {
    async function spawned(park: boolean): Promise<string> {
      const { home, project, worktree, id, reportsDir, config } = await setup();
      await new SessionStore(home).put({
        id, label: "auth", project, worktree, branch: "bench/auth-abcd1234", reportsDir,
        model: "opus", port: 3101, createdAt: "2026-08-22T00:00:00.000Z",
      });
      const registry = new SessionRegistry({
        ...config, claudeBin: await fakeCli(CREDENTIAL_CLI),
      } as any);
      await registry.restore();
      registry.setApiKey(KEY);
      if (park) registry.setApiKeyEnabled(false);

      registry.send(id, "off you go");

      // The registry does not re-emit what was said; it writes it to the
      // thread. Waiting for that line is waiting for the turn.
      const threadPath = registry.get(id)!.threadPath;
      for (let tries = 0; tries < 60; tries++) {
        await new Promise((r) => setTimeout(r, 50));
        const reply = (await readThread(threadPath)).find((e) => e.kind === "reply");
        if (reply) return reply.body;
      }
      throw new Error("the specialist never answered");
    }

    it("hands the key over while it is switched on", async () => {
      expect(await spawned(false)).toBe(`key:${KEY}`);
    });

    it("hands over nothing while it is parked, leaving the machine's login alone", async () => {
      expect(await spawned(true)).toBe("key:none");
    });

    /**
     * A key found rather than typed defaults to parked - nobody chose to
     * spend it yet, it just happened to be sitting in the environment.
     */
    it("does not hand over a key that was found in a .env until it is switched on", async () => {
      const { home, project, worktree, id, reportsDir, config } = await setup();
      await new SessionStore(home).put({
        id, label: "auth", project, worktree, branch: "bench/auth-abcd1234", reportsDir,
        model: "opus", port: 3101, createdAt: "2026-08-22T00:00:00.000Z",
      });
      const registry = new SessionRegistry({
        ...config,
        claudeBin: await fakeCli(CREDENTIAL_CLI),
        credentials: {
          anthropic: { key: KEY, origin: { from: "file", name: "ANTHROPIC_API_KEY", path: "/w/.env" } },
          router: null,
          searched: ["/w/.env"],
        },
      } as any);
      await registry.restore();

      expect(registry.apiKeyState().enabled).toBe(false);

      registry.send(id, "off you go");

      const threadPath = registry.get(id)!.threadPath;
      for (let tries = 0; tries < 60; tries++) {
        await new Promise((r) => setTimeout(r, 50));
        const reply = (await readThread(threadPath)).find((e) => e.kind === "reply");
        if (reply) {
          expect(reply.body).toBe("key:none");
          return;
        }
      }
      throw new Error("the specialist never answered");
    });

    /**
     * A key Bench found for itself has to travel the same road once the
     * developer has actually switched it on in Settings.
     *
     * Seeding a field that nothing reads would look right in Settings and do
     * nothing at all, which is the shape of the bug the switch above already
     * had once.
     */
    it("hands over a key that was found in a .env, once it is switched on", async () => {
      const { home, project, worktree, id, reportsDir, config } = await setup();
      await new SessionStore(home).put({
        id, label: "auth", project, worktree, branch: "bench/auth-abcd1234", reportsDir,
        model: "opus", port: 3101, createdAt: "2026-08-22T00:00:00.000Z",
      });
      const registry = new SessionRegistry({
        ...config,
        // What loadConfig() would hand a daemon whose developer had already
        // turned this on in Settings on some earlier run.
        apiKeyParked: false,
        claudeBin: await fakeCli(CREDENTIAL_CLI),
        credentials: {
          anthropic: { key: KEY, origin: { from: "file", name: "ANTHROPIC_API_KEY", path: "/w/.env" } },
          router: null,
          searched: ["/w/.env"],
        },
      } as any);
      await registry.restore();

      registry.send(id, "off you go");

      const threadPath = registry.get(id)!.threadPath;
      for (let tries = 0; tries < 60; tries++) {
        await new Promise((r) => setTimeout(r, 50));
        const reply = (await readThread(threadPath)).find((e) => e.kind === "reply");
        if (reply) {
          expect(reply.body).toBe(`key:${KEY}`);
          return;
        }
      }
      throw new Error("the specialist never answered");
    });

    it("says where a found key came from, and lets a typed one replace it", async () => {
      const { config } = await setup();
      const registry = new SessionRegistry({
        ...config,
        credentials: {
          anthropic: { key: KEY, origin: { from: "file", name: "ANTHROPIC_API_KEY", path: "/w/.env" } },
          router: null,
          searched: ["/w/.env"],
        },
      } as any);

      expect(registry.apiKeyState().origin).toBe("from ANTHROPIC_API_KEY in /w/.env");

      registry.setApiKey("sk-ant-api03-typed-over-the-file-9999");
      expect(registry.apiKeyState().origin).toBe("typed here");
      expect(registry.getApiKey()).toBe("sk-ant-api03-typed-over-the-file-9999");
    });

    /**
     * The switch is the developer saying where their money goes. A daemon
     * restart is not them changing their mind.
     */
    describe("the parked switch, across a restart", () => {
      it("comes back parked when it was left parked", async () => {
        const { home, config } = await setup();
        const credentials = {
          anthropic: { key: KEY, origin: { from: "file", name: "ANTHROPIC_API_KEY", path: "/w/.env" } },
          router: null,
          searched: ["/w/.env"],
        };

        const before = new SessionRegistry({ ...config, credentials } as any);
        before.setApiKeyEnabled(false);
        // The write is fire-and-forget, so wait for it to land.
        await waitFor(() => readParked(home) === true, "the flag to be written down");

        // What loadConfig() would hand the next daemon.
        const after = new SessionRegistry({
          ...config, credentials, apiKeyParked: readParked(home),
        } as any);

        expect(after.apiKeyState().present).toBe(true);
        expect(after.apiKeyState().enabled).toBe(false);
        // The whole point: it is not being spent.
        expect(after.getApiKey()).toBeNull();
      });

      it("comes back in use when it was left in use", async () => {
        const { home, config } = await setup();
        const registry = new SessionRegistry({ ...config } as any);

        registry.setApiKeyEnabled(false);
        await waitFor(() => readParked(home) === true, "the flag to be written down");
        registry.setApiKeyEnabled(true);
        await waitFor(() => (readParked(home) === false ? "written" : null), "the flag to be written down");

        expect(readParked(home)).toBe(false);
      });

      it("un-parks itself when a new key is typed in", async () => {
        // Saving a key is asking for it to be used. Finding the one you just
        // typed switched off is a fault you go looking for.
        const { home, config } = await setup();
        const registry = new SessionRegistry({ ...config, apiKeyParked: true } as any);
        expect(registry.apiKeyState().enabled).toBe(false);

        registry.setApiKey(KEY);

        expect(registry.getApiKey()).toBe(KEY);
        await waitFor(() => (readParked(home) === false ? "written" : null), "the flag to be written down");
      });

      it("un-parks itself when the key is thrown away", async () => {
        // Removing a key is not parking one. The next key given to this bench
        // is one the developer wants spent.
        const { home, config } = await setup();
        const registry = new SessionRegistry({ ...config, apiKeyParked: true } as any);

        registry.clearApiKey();

        await waitFor(() => (readParked(home) === false ? "written" : null), "the flag to be written down");
      });
    });

    it("stays gone when a found key is removed, rather than reappearing", async () => {
      // A Remove button that puts the key straight back is a button that does
      // nothing. A restart is how the developer says the opposite.
      const { config } = await setup();
      const registry = new SessionRegistry({
        ...config,
        credentials: {
          anthropic: { key: KEY, origin: { from: "file", name: "ANTHROPIC_API_KEY", path: "/w/.env" } },
          router: null,
          searched: ["/w/.env"],
        },
      } as any);

      registry.clearApiKey();

      expect(registry.getApiKey()).toBeNull();
      expect(registry.apiKeyState().present).toBe(false);
    });
  });
});

describe("what a new specialist runs on", () => {
  it("takes the model from the role when the caller names none", async () => {
    // The CLI knows what kind of agent it is opening and nothing else. It
    // used to fall back to Opus, which made every researcher a flagship.
    const { config } = await setup();
    const registry = new SessionRegistry(config as never);

    expect(registry.modelFor("planner")).toBe("opus");
    expect(registry.modelFor("specialist")).toBe("opus");
  });

  it("falls back to something direct when there is no OpenRouter key", async () => {
    // A registry built for a test finds no credentials, which is exactly the
    // case this fallback is for: the cheap model is unreachable, and running
    // Opus instead without saying so is the expensive silent failure.
    const { config } = await setup();
    const registry = new SessionRegistry(config as never);

    expect(registry.modelFor("researcher")).toBe("haiku");
    expect(registry.modelFor("implementer")).toBe("sonnet");
  });

  it("prefers the developer's own answer over the built-in one", async () => {
    const { config, home } = await setup();
    await writeFile(
      join(home, "settings.json"),
      JSON.stringify({ codingStyle: "", workflowRules: "", roleModels: { researcher: "sonnet" } }),
    );
    const registry = new SessionRegistry(config as never);
    await registry.restore();

    expect(registry.modelFor("researcher")).toBe("sonnet");
  });
});

/** A real repo, since `create()` provisions a real worktree. A fake CLI so
 * the process it spawns is not an unhandled ENOENT on a machine with no
 * `claude` installed. */
async function setupForCreate(cli: string = REPLYING_CLI) {
  const home = await mkdtemp(join(tmpdir(), "bench-home-"));
  const project = await mkdtemp(join(tmpdir(), "bench-proj-"));
  await exec("git", ["init", "-q", "-b", "main"], { cwd: project });
  await exec("git", ["config", "user.email", "t@t.io"], { cwd: project });
  await exec("git", ["config", "user.name", "t"], { cwd: project });
  await writeFile(join(project, "README.md"), "x");
  await exec("git", ["add", "-A"], { cwd: project });
  await exec("git", ["commit", "-qm", "init"], { cwd: project });

  const config = {
    home, port: 7420, token: "t",
    pluginDir: "/nonexistent/plugin",
    hookCommand: "node /nonexistent/hook.js",
    projectsRoot: project,
    claudeBin: await fakeCli(cli),
  };

  const registry = new SessionRegistry(config as any);
  return { home, project, registry, config };
}

/** A second daemon over the same home - the only way to test what a restart
 * actually keeps, rather than what the object in memory still happens to
 * hold. */
async function afterRestart(config: unknown): Promise<SessionRegistry> {
  const next = new SessionRegistry(config as any);
  await next.restore();
  return next;
}

const rowOf = (registry: SessionRegistry, id: string) => registry.list().find((r) => r.id === id)!;

describe("a tab another specialist spins up", () => {
  it("writes who opened it down, so a restart keeps it nested under its parent", async () => {
    // `createdBy` is what the roster nests on. Held in memory only, the next
    // daemon reads `null` and the child ends up loose at the top of the group
    // instead of under the specialist that opened it.
    const { home, project, registry } = await setupForCreate();
    const id = await registry.create({ project, label: "child", model: "opus", createdBy: "sess-parent" });

    // The store write inside create() is awaited, but wait on the record
    // itself anyway for anything the registry fires off without waiting on.
    const record = await waitFor(
      async () => (await new SessionStore(home).all()).find((r) => r.id === id) ?? null,
      "the store write inside create() to land",
    );
    expect(record.createdBy).toBe("sess-parent");
  });

  it("holds the first message instead of sending it", async () => {
    const { project, registry } = await setupForCreate();
    const id = await registry.create({ project, label: "child", model: "opus", createdBy: "sess-parent" });

    registry.send(id, "build the thing", "sess-parent");

    const row = rowOf(registry, id);
    expect(row.status).toBe("awaiting_dispatch");
    expect(row.pendingPrompt).toBe("build the thing");
  });

  it("does not hold a message for a tab the developer opened themselves", async () => {
    // No createdBy: this came from the cockpit's own "New specialist"
    // dialog, not from another specialist's `bench new`.
    const { project, registry } = await setupForCreate();
    const id = await registry.create({ project, label: "child", model: "opus" });

    registry.send(id, "hello");

    const row = rowOf(registry, id);
    expect(row.status).toBe("working");
    expect(row.pendingPrompt).toBeNull();
  });

  it("replaces the held message when told again before it is dispatched", async () => {
    const { project, registry } = await setupForCreate();
    const id = await registry.create({ project, label: "child", model: "opus", createdBy: "sess-parent" });

    registry.send(id, "first", "sess-parent");
    registry.send(id, "second", "sess-parent");

    expect(rowOf(registry, id).pendingPrompt).toBe("second");
  });

  it("dispatches the held message on request", async () => {
    const { project, registry } = await setupForCreate();
    const id = await registry.create({ project, label: "child", model: "opus", createdBy: "sess-parent" });
    registry.send(id, "build the thing", "sess-parent");

    await registry.dispatch(id);

    const row = rowOf(registry, id);
    expect(row.status).toBe("working");
    expect(row.pendingPrompt).toBeNull();
  });

  it("refuses to dispatch when nothing is held", async () => {
    const { project, registry } = await setupForCreate();
    const id = await registry.create({ project, label: "child", model: "opus", createdBy: "sess-parent" });

    await expect(registry.dispatch(id)).rejects.toThrow(/nothing/i);
  });

  /**
   * A held brief is the whole subject of a decision the developer has not
   * made yet. Held in memory only, `bench restart` destroyed it and left the
   * tab reading "ready" - indistinguishable from one never given work, so
   * the natural reading was that the agent had ignored its instructions
   * (#66).
   */
  describe("across a daemon restart", () => {
    it("still has the brief, and still says it is waiting on you", async () => {
      const { home, project, registry, config } = await setupForCreate();
      const id = await registry.create({ project, label: "child", model: "opus", createdBy: "sess-parent" });
      registry.send(id, "build the thing", "sess-parent");
      await waitFor(
        async () => ((await new SessionStore(home).all()).find((r) => r.id === id)?.pendingDispatch ?? null),
        "the held prompt to land on disk",
      );

      const row = rowOf(await afterRestart(config), id);
      expect(row.status).toBe("awaiting_dispatch");
      expect(row.detail).toBe("waiting on you to dispatch");
      expect(row.pendingPrompt).toBe("build the thing");
    });

    it("delivers exactly the text that was held, not a summary of it", async () => {
      const { home, project, registry, config } = await setupForCreate();
      const id = await registry.create({ project, label: "child", model: "opus", createdBy: "sess-parent" });
      registry.send(id, "line one\n\nline two", "sess-parent");
      await waitFor(
        async () => ((await new SessionStore(home).all()).find((r) => r.id === id)?.pendingDispatch ?? null),
        "the held prompt to land on disk",
      );

      const next = await afterRestart(config);
      const deliver = vi.spyOn(next as any, "deliver").mockImplementation(() => {});
      await next.dispatch(id);

      expect(deliver).toHaveBeenCalledWith(id, expect.anything(), "line one\n\nline two", []);
    });

    it("keeps a decline declined, rather than resurrecting the brief", async () => {
      const { home, project, registry, config } = await setupForCreate();
      const store = new SessionStore(home);
      const id = await registry.create({ project, label: "child", model: "opus", createdBy: "sess-parent" });
      registry.send(id, "build the thing", "sess-parent");
      await waitFor(
        async () => ((await store.all()).find((r) => r.id === id)?.pendingDispatch ?? null),
        "the held prompt to land on disk",
      );
      registry.decline(id);
      await waitFor(
        async () => ((await store.all()).find((r) => r.id === id)?.pendingDispatch === null ? true : null),
        "the decline to land on disk",
      );

      const row = rowOf(await afterRestart(config), id);
      expect(row.status).toBe("awaiting_decision");
      expect(row.pendingPrompt).toBeNull();
    });

    it("leaves a tab that was never given work reading as ready", async () => {
      const { project, registry, config } = await setupForCreate();
      // create() awaits its own store write, so the record is already on disk
      // by the time it resolves - nothing to wait on here.
      const id = await registry.create({ project, label: "child", model: "opus", createdBy: "sess-parent" });

      const row = rowOf(await afterRestart(config), id);
      expect(row.status).toBe("awaiting_decision");
      expect(row.detail).toBe("ready");
      expect(row.pendingPrompt).toBeNull();
    });
  });

  it("declines the held message, leaving the tab as if it were never told", async () => {
    const { project, registry } = await setupForCreate();
    const id = await registry.create({ project, label: "child", model: "opus", createdBy: "sess-parent" });
    registry.send(id, "build the thing", "sess-parent");

    registry.decline(id);

    const row = rowOf(registry, id);
    expect(row.status).toBe("awaiting_decision");
    expect(row.pendingPrompt).toBeNull();
  });

  it("does not hold what the developer typed themselves", async () => {
    // The cockpit's composer sends no `from`, and holding the developer's own
    // words to hand back to them for dispatch is a loop with nobody in it.
    const { project, registry } = await setupForCreate();
    const id = await registry.create({ project, label: "child", model: "opus", createdBy: "sess-parent" });

    registry.send(id, "actually, do this instead");

    const row = rowOf(registry, id);
    expect(row.status).toBe("working");
    expect(row.pendingPrompt).toBeNull();
  });

  it("goes on holding it while the developer moves it onto another model", async () => {
    // Changing the model lets the idle process go, and the exit used to be
    // read as an ordinary stop - which took the held prompt off the roster
    // with the modal still open over it.
    const { project, registry } = await setupForCreate();
    const id = await registry.create({ project, label: "child", model: "opus", createdBy: "sess-parent" });
    registry.send(id, "build the thing", "sess-parent");

    await registry.setModel(id, "haiku");
    // The process is let go asynchronously, and the exit is where the status
    // was being overwritten - so waiting on the row's own words would pass
    // before the thing under test had happened.
    await waitFor(
      () => (registry.get(id)!.alive === false ? "gone" : null),
      "the process it was made with to go",
    );

    const row = rowOf(registry, id);
    expect(row.status).toBe("awaiting_dispatch");
    expect(row.pendingPrompt).toBe("build the thing");
    expect(row.model).toBe("haiku");
  });

  it("dispatches onto the model the developer moved it to", async () => {
    const { project, registry } = await setupForCreate();
    const id = await registry.create({ project, label: "child", model: "opus", createdBy: "sess-parent" });
    registry.send(id, "build the thing", "sess-parent");
    await registry.setModel(id, "haiku");
    // The process is let go asynchronously, and the exit is where the status
    // was being overwritten - so waiting on the row's own words would pass
    // before the thing under test had happened.
    await waitFor(
      () => (registry.get(id)!.alive === false ? "gone" : null),
      "the process it was made with to go",
    );

    await registry.dispatch(id);

    const row = rowOf(registry, id);
    expect(row.status).toBe("working");
    expect(row.pendingPrompt).toBeNull();
  });

  it("does not hold a second message once the tab has taken its first turn", async () => {
    const { project, registry } = await setupForCreate();
    const id = await registry.create({ project, label: "child", model: "opus", createdBy: "sess-parent" });
    registry.send(id, "first", "sess-parent");
    await registry.dispatch(id);

    registry.send(id, "second", "sess-parent");

    const row = rowOf(registry, id);
    expect(row.status).toBe("working");
    expect(row.pendingPrompt).toBeNull();
  });

  it("does not re-park a retry behind a crash that happened before the first turn finished", async () => {
    // Once dispatched, a crash before the CLI ever completes a turn used to
    // look exactly like a fresh, never-dispatched tab to `send()` - so a
    // "retry" nudge sent after the crash was held as the new pendingDispatch,
    // silently discarding the real brief that had already been approved.
    const { project, registry } = await setupForCreate(COLLIDING_CLI);
    const id = await registry.create({ project, label: "child", model: "opus", createdBy: "sess-parent" });
    registry.send(id, "do the research", "sess-parent");
    await registry.dispatch(id);
    await waitFor(() => (rowOf(registry, id).status === "crashed" ? true : null), "the collision to crash it");

    registry.send(id, "retry", "sess-parent");

    const row = rowOf(registry, id);
    expect(row.status).toBe("working");
    expect(row.pendingPrompt).toBeNull();
  });
});

describe("a report on a tab another specialist opened", () => {
  it("wakes the parent with a pointer to the child's report", async () => {
    const { project, registry } = await setupForCreate(REPORTING_CLI);
    const parentId = await registry.create({ project, label: "parent", model: "opus" });
    registry.send(parentId, "get started");
    await waitFor(() => (rowOf(registry, parentId).status !== "working" ? true : null), "parent's own turn to finish");

    const childId = await registry.create({ project, label: "child", model: "opus", createdBy: parentId });
    // From the parent, as `bench tell` sends it. Holding turns on a sender
    // being named: what the developer types is never held back from the
    // specialist they typed it to, so an unattributed message here would go
    // straight through and there would be nothing to dispatch.
    registry.send(childId, "build the thing", parentId);
    await registry.dispatch(childId);
    await waitFor(() => (rowOf(registry, childId).status !== "working" ? true : null), "child's turn to finish");

    // The append to the parent's thread is not awaited by the turn-end
    // handler that triggers it (see registry.ts), so the child's own status
    // can flip before that write has landed on disk - poll rather than
    // read once. waitFor only takes a synchronous read, so a sync file read
    // rather than readThread.
    const parent = registry.get(parentId)!;
    const line = await waitFor(() => {
      let raw: string;
      try { raw = readFileSync(parent.threadPath, "utf8"); } catch { return null; }
      return raw.split("\n").find((l) => l.includes("wrote a report")) ?? null;
    }, "the parent to hear about the child's report");
    const notified = JSON.parse(line) as { body: string };
    expect(notified.body).toContain("child wrote a report");
    expect(notified.body).toContain("bench tell child");
  });

  it("does not try to notify a tab the developer opened themselves", async () => {
    // No createdBy, so nobody made this one - and nobody is waiting to hear
    // about its report.
    const { project, registry } = await setupForCreate(REPORTING_CLI);
    const soloId = await registry.create({ project, label: "solo", model: "opus" });

    registry.send(soloId, "get started");

    await waitFor(() => (rowOf(registry, soloId).status !== "working" ? true : null), "the turn to finish");
    expect(rowOf(registry, soloId).status).not.toBe("crashed");
  });
});
