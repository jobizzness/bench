import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionRegistry } from "../src/daemon/registry.js";
import { SessionStore } from "../src/daemon/store.js";
import { waitFor } from "./helpers/wait-for.js";

async function bench(label = "auth") {
  const home = await mkdtemp(join(tmpdir(), "bench-home-"));
  const project = await mkdtemp(join(tmpdir(), "bench-proj-"));
  const worktree = join(project, ".claude", "worktrees", "auth");
  const reportsDir = join(project, ".bench", "reports", "s1");
  await mkdir(worktree, { recursive: true });
  await mkdir(reportsDir, { recursive: true });

  await new SessionStore(home).put({
    id: "s1", label, project, worktree, branch: "bench/auth-abcd1234", reportsDir,
    model: "opus", port: 3101, createdAt: "2026-08-22T00:00:00.000Z",
  });

  const registry = new SessionRegistry({
    home, port: 7420, token: "t", pluginDir: "/nonexistent/plugin",
    hookCommand: "node /nonexistent/hook.js", projectsRoot: project,
  } as any);
  await registry.restore();
  return { home, registry };
}

describe("renaming a specialist", () => {
  it("changes the name on the roster and announces it", async () => {
    const { registry } = await bench();
    let announced = 0;
    registry.on("roster", () => { announced++; });

    expect(registry.rename("s1", "session cookies on Safari")).toBe(true);
    expect(registry.list()[0].label).toBe("session cookies on Safari");
    expect(announced).toBe(1);
  });

  it("survives the daemon restarting", async () => {
    const { home, registry } = await bench();
    registry.rename("s1", "Safari cookies");
    // The registry writes without being awaited, so the next daemon is the
    // thing that has to see it.
    await waitFor(
      async () => ((await new SessionStore(home).all())[0]?.label === "Safari cookies" ? true : null),
      "the rename to land on disk",
    );

    const next = new SessionRegistry({
      home, port: 7420, token: "t", pluginDir: "/p", hookCommand: "h", projectsRoot: "/",
    } as any);
    await next.restore();
    expect(next.list()[0].label).toBe("Safari cookies");
  });

  it("leaves the branch and the worktree where they were", async () => {
    const { registry } = await bench();
    registry.rename("s1", "something else entirely");

    // Cut when the specialist was made, possibly already pushed. The header
    // shows it, so the drift is visible rather than silently repaired.
    expect(registry.list()[0].branch).toBe("bench/auth-abcd1234");
  });

  it("refuses a name that is empty or too long to be one", async () => {
    const { registry } = await bench();
    expect(registry.rename("s1", "   ")).toBe(false);
    expect(registry.rename("s1", "x".repeat(200))).toBe(false);
    expect(registry.list()[0].label).toBe("auth");
  });

  it("refuses a specialist that is not on the bench", async () => {
    const { registry } = await bench();
    expect(registry.rename("nobody", "hello")).toBe(false);
  });

  it("keeps the name off the record when there is no record", async () => {
    const home = await mkdtemp(join(tmpdir(), "bench-store-"));
    const store = new SessionStore(home);
    await store.rename("ghost", "hello");
    expect(await store.all()).toEqual([]);
  });
});
