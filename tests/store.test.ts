import { describe, it, expect } from "vitest";
import { mkdtemp, writeFile, mkdir, readFile } from "node:fs/promises";
import { readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CorruptIndex, SessionStore } from "../src/daemon/store.js";

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

  // This used to assert the opposite - that an unreadable index reads as
  // empty, so a bad file could never wedge boot. It cost a developer their
  // whole roster: the cockpit came up empty, and the first write would have
  // made that permanent.
  it("refuses to read an index it cannot parse, rather than calling it empty", async () => {
    const home = await mkdtemp(join(tmpdir(), "bench-store-"));
    await mkdir(home, { recursive: true });
    await writeFile(join(home, "sessions.json"), "{ this is not json");

    await expect(new SessionStore(home).all()).rejects.toThrow(CorruptIndex);
  });

  it("refuses to write over an index it could not read", async () => {
    const home = await mkdtemp(join(tmpdir(), "bench-store-"));
    const path = join(home, "sessions.json");
    const corrupt = JSON.stringify([record("a"), record("b")]).slice(0, 120);
    await writeFile(path, corrupt);

    const store = new SessionStore(home);
    await expect(store.put(record("c"))).rejects.toThrow(CorruptIndex);
    await expect(store.remove("a")).rejects.toThrow(CorruptIndex);

    // The whole point: what could not be read is still there to recover.
    expect(await readFile(path, "utf8")).toBe(corrupt);
  });

  it("never leaves a half-written index where a reader can see it", async () => {
    // Two daemons on one home is what caused this, but one writer is enough
    // to show it: `writeFile` truncates before it writes, so anyone reading
    // during that gap gets a file that is not JSON - which the old `all()`
    // then reported as an empty bench. A rename cannot be seen half-done.
    const home = await mkdtemp(join(tmpdir(), "bench-store-"));
    const path = join(home, "sessions.json");

    // Big enough that the write cannot slip between two reads.
    const bulk = Array.from({ length: 4000 }, (_, i) => record(`bulk-${i}`));
    await writeFile(path, JSON.stringify(bulk));

    const store = new SessionStore(home);
    let done = false;
    const writing = store.put(record("new")).then(() => { done = true; });

    let reads = 0;
    let torn = 0;
    while (!done) {
      reads++;
      try {
        JSON.parse(readFileSync(path, "utf8"));
      } catch {
        torn++;
      }
      await new Promise((resolve) => setImmediate(resolve));
    }
    await writing;

    expect(reads).toBeGreaterThan(0);
    expect(torn).toBe(0);
    // And nothing of ours is left lying beside it.
    expect(readdirSync(home)).toEqual(["sessions.json"]);
  });

  // What the daemon does at the end of every single turn: the context number
  // and the resumable flag, from the same tick, neither of them awaited.
  describe("two changes at once", () => {
    const home = async () => {
      const dir = await mkdtemp(join(tmpdir(), "bench-store-"));
      await new SessionStore(dir).put(record("a"));
      return dir;
    };

    it("keeps both of them", async () => {
      // Overlapping, the second reads before the first has written, so it
      // saves a copy of the record that never had the first change on it.
      const dir = await home();
      const store = new SessionStore(dir);

      await Promise.all([
        store.rememberContext("a", { used: 1234, window: 200_000 }),
        store.markResumable("a"),
      ]);

      const [saved] = await new SessionStore(dir).all();
      expect(saved.context).toEqual({ used: 1234, window: 200_000 });
      expect(saved.resumable).toBe(true);
    });

    it("does not leave the index unreadable", async () => {
      // Writing both to one temp file named after the process, they
      // interleaved inside it - and the rename then put that atomically in
      // place of a perfectly good index.
      const dir = await home();
      const store = new SessionStore(dir);

      await Promise.all([
        store.rememberContext("a", { used: 500, window: 200_000 }),
        store.markResumable("a"),
        store.put(record("b")),
        store.put(record("c")),
      ]);

      const saved = await new SessionStore(dir).all();
      expect(saved.map((r) => r.id).sort()).toEqual(["a", "b", "c"]);
    });

    it("does not crash on the second one", async () => {
      // The first rename moved the shared temp file away, so the second
      // found nothing to rename - and an unawaited rejection ends the
      // process, which is how stopping one turn took down a whole bench.
      const dir = await home();
      const store = new SessionStore(dir);

      const both = [store.markResumable("a"), store.rememberContext("a", { used: 1, window: 2 })];
      await expect(Promise.all(both)).resolves.toBeDefined();
    });

    it("leaves nothing beside the index", async () => {
      const dir = await home();
      const store = new SessionStore(dir);
      await Promise.all([
        store.rememberContext("a", { used: 1, window: 2 }),
        store.markResumable("a"),
        store.put(record("b")),
      ]);

      expect(readdirSync(dir)).toEqual(["sessions.json"]);
    });

    it("goes on writing after one of them fails", async () => {
      // A queue that stops at the first failure would silently stop
      // recording anything for the rest of the daemon's life.
      const dir = await home();
      const store = new SessionStore(dir);

      const corrupt = join(dir, "sessions.json");
      await writeFile(corrupt, "{ not json");
      await expect(store.markResumable("a")).rejects.toThrow(CorruptIndex);

      await writeFile(corrupt, JSON.stringify([record("a")]));
      await store.rememberContext("a", { used: 7, window: 9 });
      expect((await store.all())[0].context).toEqual({ used: 7, window: 9 });
    });
  });

  it("ignores entries that are not shaped like a session", async () => {
    const home = await mkdtemp(join(tmpdir(), "bench-store-"));
    await writeFile(join(home, "sessions.json"), JSON.stringify([record("a"), { nonsense: true }, null]));
    expect((await new SessionStore(home).all()).map((r) => r.id)).toEqual(["a"]);
  });
});
