import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionRegistry } from "../src/daemon/registry.js";
import { SessionStore } from "../src/daemon/store.js";

async function setup() {
  const home = await mkdtemp(join(tmpdir(), "bench-home-"));
  const project = await mkdtemp(join(tmpdir(), "bench-proj-"));
  const worktree = join(project, ".claude", "worktrees", "auth");
  await mkdir(worktree, { recursive: true });

  const id = "sess-remodel";
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
    id, label: "auth", project, worktree, branch: "bench/auth-abcd1234", reportsDir,
    model: "opus", port: 3101, createdAt: "2026-08-22T00:00:00.000Z",
  });

  const registry = new SessionRegistry(config as any);
  await registry.restore();
  return { registry, store, id, home };
}

describe("moving a specialist to another model", () => {
  it("records the new model on the row", async () => {
    const { registry, id } = await setup();
    await registry.setModel(id, "haiku");
    expect(registry.list().find((r) => r.id === id)!.model).toBe("haiku");
  });

  it("writes it down, so a restart does not put it back", async () => {
    // The model is what a revived specialist is spawned with. A change held
    // only in memory would quietly move it back on the next daemon.
    const { registry, store, id } = await setup();
    await registry.setModel(id, "fable");

    // The write is not awaited by setModel - it is a store write nobody is
    // blocking on - so give it the tick it needs.
    await new Promise((r) => setTimeout(r, 50));
    expect((await store.all()).find((r) => r.id === id)!.model).toBe("fable");
  });

  it("refuses a model this bench does not offer", async () => {
    const { registry, id } = await setup();
    await expect(registry.setModel(id, "gpt-2")).rejects.toThrow(/not a model this bench offers/);
    expect(registry.list().find((r) => r.id === id)!.model).toBe("opus");
  });

  it("refuses one whose provider has no key, and changes nothing", async () => {
    // The refusal has to land here, while the developer is looking at the
    // modal - not on the next prompt, two minutes later.
    const { registry, id } = await setup();
    await expect(registry.setModel(id, "google/gemini-3.7-flash"))
      .rejects.toThrow(/no OpenRouter key/);
    expect(registry.list().find((r) => r.id === id)!.model).toBe("opus");
  });

  it("says nothing and does nothing when it is already on that model", async () => {
    const { registry, id } = await setup();
    await registry.setModel(id, "opus");
    expect(registry.list().find((r) => r.id === id)!.model).toBe("opus");
  });

  it("has never heard of a specialist that is not there", async () => {
    const { registry } = await setup();
    await expect(registry.setModel("nobody", "haiku")).rejects.toThrow(/no such specialist/);
  });
});
