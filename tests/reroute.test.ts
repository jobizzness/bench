import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionRegistry } from "../src/daemon/registry.js";
import { SessionStore } from "../src/daemon/store.js";
import { ROLE_MODELS } from "../src/shared/role-models.js";

/**
 * Changing what kind of agent a tab holds.
 *
 * The same shape as changing its model, and for the same reason: the role
 * reaches the process as a system prompt and a system prompt is fixed at
 * spawn, so the change is recorded and the next prompt revives it.
 */

async function setup(over: { role?: string; model?: string } = {}) {
  const home = await mkdtemp(join(tmpdir(), "bench-home-"));
  const project = await mkdtemp(join(tmpdir(), "bench-proj-"));
  const worktree = join(project, ".claude", "worktrees", "auth");
  await mkdir(worktree, { recursive: true });

  const id = "sess-reroute";
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
    role: over.role ?? "specialist",
    model: over.model ?? ROLE_MODELS.specialist.preferred,
    port: 3101, createdAt: "2026-08-22T00:00:00.000Z",
  });

  const registry = new SessionRegistry(config as any);
  await registry.restore();
  const row = () => registry.list().find((r) => r.id === id)!;
  return { registry, store, id, home, row };
}

describe("changing what a specialist is", () => {
  it("records the new role on the row", async () => {
    const { registry, id, row } = await setup();
    await registry.setRole(id, "reviewer");
    expect(row().role).toBe("reviewer");
  });

  it("remembers it, so a daemon restart does not undo it", async () => {
    const { registry, store, id } = await setup();
    await registry.setRole(id, "researcher");

    // The store write is not awaited by setRole - nobody is waiting on it.
    for (let tries = 0; tries < 50 && (await store.all()).find((r) => r.id === id)?.role !== "researcher"; tries++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect((await store.all()).find((r) => r.id === id)!.role).toBe("researcher");
  });

  it("does nothing at all when it is already that", async () => {
    const { registry, id, row } = await setup({ role: "reviewer", model: "haiku" });
    await registry.setRole(id, "reviewer");
    expect(row().model).toBe("haiku");
  });

  it("refuses a role this bench does not have, and changes nothing", async () => {
    // A word that is not a role reaches the spawn, where it indexes
    // ROLE_BRIEF and hands the agent `undefined` as its entire system
    // prompt. Refused here as well as at the route.
    const { registry, id, row } = await setup();

    await expect(registry.setRole(id, "gardener" as never))
      .rejects.toThrow(/not a role this bench has/);

    expect(row().role).toBe("specialist");
  });
});

describe("what changing the role does to the model", () => {
  it("moves a tab that was taking whatever its role runs on", async () => {
    // Otherwise a reviewer promoted to implementer stays on the cheap model
    // the review was costed for, and its turns quietly stop compiling.
    const { registry, id, row } = await setup({
      role: "reviewer",
      model: ROLE_MODELS.reviewer.direct,
    });

    await registry.setRole(id, "planner");

    expect(row().role).toBe("planner");
    expect(row().model).toBe(ROLE_MODELS.planner.direct);
  });

  it("leaves a model the developer picked by hand exactly where it is", async () => {
    // They went to the picker and chose. Moving them off it because they
    // relabelled the tab throws away the more specific of two answers.
    const { registry, id, row } = await setup({ role: "reviewer", model: "fable" });

    await registry.setRole(id, "implementer");

    expect(row().role).toBe("implementer");
    expect(row().model).toBe("fable");
  });

  it("does not move the model when the new role runs on the same one", async () => {
    const { registry, id, row } = await setup({
      role: "specialist",
      model: ROLE_MODELS.specialist.preferred,
    });

    await registry.setRole(id, "planner");

    // Both are opus, so there is nothing to change and nothing to announce.
    expect(row().model).toBe(ROLE_MODELS.planner.preferred);
  });
});
