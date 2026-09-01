import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "../src/daemon/store.js";
import { SessionRegistry } from "../src/daemon/registry.js";
import { waitFor } from "./helpers/wait-for.js";

const record = (id: string, over: Partial<any> = {}) => ({
  id,
  label: id,
  project: "/var/www/demo",
  worktree: "/var/www/demo/.claude/worktrees/" + id,
  reportsDir: `/var/www/demo/.bench/reports/${id}`,
  model: "opus",
  port: 3101,
  createdAt: "2026-08-22T00:00:00.000Z",
  ...over,
});

describe("SessionStore.setBroadcast", () => {
  it("is false on a record that never set it", async () => {
    const home = await mkdtemp(join(tmpdir(), "bench-store-"));
    const store = new SessionStore(home);
    await store.put(record("a"));

    const all = await store.all();
    expect(all[0].broadcast).toBeUndefined();
  });

  it("persists across instances", async () => {
    const home = await mkdtemp(join(tmpdir(), "bench-store-"));
    const store = new SessionStore(home);
    await store.put(record("a"));
    await store.setBroadcast("a", true);

    const reloaded = await new SessionStore(home).all();
    expect(reloaded[0].broadcast).toBe(true);
  });

  it("does nothing for an id that does not exist", async () => {
    const home = await mkdtemp(join(tmpdir(), "bench-store-"));
    const store = new SessionStore(home);
    await store.setBroadcast("nope", true);
    expect(await store.all()).toEqual([]);
  });
});

async function setup() {
  const home = await mkdtemp(join(tmpdir(), "bench-home-"));
  const project = await mkdtemp(join(tmpdir(), "bench-proj-"));
  await mkdir(join(project, ".claude", "worktrees"), { recursive: true });
  const config = {
    home,
    port: 7420,
    token: "t",
    pluginDir: "/nonexistent/plugin",
    hookCommand: "node /nonexistent/hook.js",
    projectsRoot: project,
  };
  return { home, project, config };
}

/** A record with just enough shape for `restore()` to accept it, so these
 * tests never have to spin up a real worktree or CLI process to exercise
 * broadcast - the same shortcut `registry.test.ts` uses for restore tests. */
function seed(id: string, project: string, over: Partial<any> = {}) {
  const reportsDir = join(project, ".bench", "reports", id);
  return record(id, { project, reportsDir, ...over });
}

describe("SessionRegistry.setBroadcast", () => {
  it("turns broadcast on for exactly the specialist asked", async () => {
    const { project, config } = await setup();
    const store = new SessionStore(config.home);
    await store.put(seed("parent", project));

    const registry = new SessionRegistry(config as any);
    await registry.restore();
    await registry.setBroadcast("parent", true);

    expect(registry.list().find((r) => r.id === "parent")?.broadcast).toBe(true);
  });

  it("cascades to every sub-agent tab it opened, at any depth", async () => {
    const { project, config } = await setup();
    const store = new SessionStore(config.home);
    await store.put(seed("parent", project));
    await store.put(seed("child", project, { createdBy: "parent" }));
    await store.put(seed("grandchild", project, { createdBy: "child" }));
    await store.put(seed("unrelated", project));

    const registry = new SessionRegistry(config as any);
    await registry.restore();
    await registry.setBroadcast("parent", true);

    const rows = new Map(registry.list().map((r) => [r.id, r]));
    expect(rows.get("parent")?.broadcast).toBe(true);
    expect(rows.get("child")?.broadcast).toBe(true);
    expect(rows.get("grandchild")?.broadcast).toBe(true);
    expect(rows.get("unrelated")?.broadcast).toBe(false);
  });

  it("turning it back off also carries the descendants, and persists", async () => {
    const { project, config } = await setup();
    const store = new SessionStore(config.home);
    await store.put(seed("parent", project));
    await store.put(seed("child", project, { createdBy: "parent" }));

    const registry = new SessionRegistry(config as any);
    await registry.restore();
    await registry.setBroadcast("parent", true);
    await registry.setBroadcast("parent", false);

    const rows = new Map(registry.list().map((r) => [r.id, r]));
    expect(rows.get("parent")?.broadcast).toBe(false);
    expect(rows.get("child")?.broadcast).toBe(false);

    // `registry.setBroadcast` returns once the in-memory row and the write
    // have been kicked off, not once the write has landed - same as every
    // other registry mutation that goes through `remember()`. `waitFor` only
    // takes a synchronous read, so this polls the file directly.
    let onDisk: boolean | undefined;
    const deadline = Date.now() + 3000;
    do {
      onDisk = (await new SessionStore(config.home).all()).find((r) => r.id === "child")?.broadcast;
      if (onDisk === false) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    } while (Date.now() < deadline);
    expect(onDisk).toBe(false);
  });

  it("emits one roster update per call, not one per descendant", async () => {
    const { project, config } = await setup();
    const store = new SessionStore(config.home);
    await store.put(seed("parent", project));
    await store.put(seed("child", project, { createdBy: "parent" }));

    const registry = new SessionRegistry(config as any);
    await registry.restore();

    let fired = 0;
    registry.on("roster", () => { fired += 1; });
    await registry.setBroadcast("parent", true);

    expect(fired).toBe(1);
  });

  it("rejects an id that does not exist", async () => {
    const { config } = await setup();
    const registry = new SessionRegistry(config as any);
    await registry.restore();
    await expect(registry.setBroadcast("nope", true)).rejects.toThrow();
  });
});
