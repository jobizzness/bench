import { describe, it, expect } from "vitest";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "../src/daemon/store.js";

const record = (id: string, over: Partial<any> = {}) => ({
  id,
  label: "auth",
  project: "/var/www/demo",
  worktree: "/var/www/demo/.claude/worktrees/auth",
  reportsDir: `/var/www/demo/.bench/reports/${id}`,
  model: "opus",
  port: 3101,
  createdAt: "2026-08-22T00:00:00.000Z",
  ...over,
});

describe("SessionStore", () => {
  it("returns nothing before anything has been written", async () => {
    const home = await mkdtemp(join(tmpdir(), "bench-store-"));
    expect(await new SessionStore(home).all()).toEqual([]);
  });

  it("round-trips a record across instances", async () => {
    const home = await mkdtemp(join(tmpdir(), "bench-store-"));
    await new SessionStore(home).put(record("a"));

    // A second instance stands in for the next daemon process.
    const reloaded = await new SessionStore(home).all();
    expect(reloaded).toHaveLength(1);
    expect(reloaded[0].label).toBe("auth");
    expect(reloaded[0].worktree).toContain("worktrees/auth");
  });

  it("keeps several specialists and replaces one by id", async () => {
    const home = await mkdtemp(join(tmpdir(), "bench-store-"));
    const store = new SessionStore(home);
    await store.put(record("a"));
    await store.put(record("b", { label: "billing" }));
    await store.put(record("a", { label: "renamed" }));

    const all = await store.all();
    expect(all).toHaveLength(2);
    expect(all.find((r) => r.id === "a")?.label).toBe("renamed");
    expect(all.find((r) => r.id === "b")?.label).toBe("billing");
  });

  it("removes a record", async () => {
    const home = await mkdtemp(join(tmpdir(), "bench-store-"));
    const store = new SessionStore(home);
    await store.put(record("a"));
    await store.put(record("b"));
    await store.remove("a");

    expect((await store.all()).map((r) => r.id)).toEqual(["b"]);
  });

  it("creates its home directory rather than failing", async () => {
    const home = join(await mkdtemp(join(tmpdir(), "bench-store-")), "nested", "bench");
    await new SessionStore(home).put(record("a"));
    expect(await new SessionStore(home).all()).toHaveLength(1);
  });

  it("treats an unreadable index as empty, so a bad file cannot wedge boot", async () => {
    const home = await mkdtemp(join(tmpdir(), "bench-store-"));
    await mkdir(home, { recursive: true });
    await writeFile(join(home, "sessions.json"), "{ this is not json");

    const store = new SessionStore(home);
    expect(await store.all()).toEqual([]);
    // and it recovers: writing works over the top of the corrupt file
    await store.put(record("a"));
    expect(await store.all()).toHaveLength(1);
  });

  it("ignores entries that are not shaped like a session", async () => {
    const home = await mkdtemp(join(tmpdir(), "bench-store-"));
    await writeFile(join(home, "sessions.json"), JSON.stringify([record("a"), { nonsense: true }, null]));
    expect((await new SessionStore(home).all()).map((r) => r.id)).toEqual(["a"]);
  });
});
