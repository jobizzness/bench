import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionRegistry } from "../src/daemon/registry.js";

/**
 * A process ending looks the same whether it fell over or was ended on
 * purpose, so the registry has to mark which it was before the kill. That
 * ordering is the whole contract, and it is what these assert - not a
 * re-implementation of the exit handler, which would only test itself.
 */
async function withEntry(over: Record<string, unknown> = {}) {
  const home = await mkdtemp(join(tmpdir(), "bench-stop-"));
  const project = await mkdtemp(join(tmpdir(), "bench-stop-p-"));
  const reportsDir = join(project, ".bench", "reports", "s1");
  await mkdir(reportsDir, { recursive: true });
  await writeFile(join(reportsDir, "thread.jsonl"), "");

  const registry = new SessionRegistry({
    home, host: "127.0.0.1", port: 7420, token: "t",
    pluginDir: "/nonexistent", hookCommand: "true", projectsRoot: project,
  } as any);

  /** What `stopping` was at the instant the process was told to go. */
  let markedWhenKilled: boolean | null = null;

  const entry: Record<string, unknown> = {
    reportsDir,
    threadPath: join(reportsDir, "thread.jsonl"),
    session: {
      stop() {
        markedWhenKilled = (registry as any).entries.get("s1").stopping === true;
      },
    },
    alive: true, worktree: project, branch: "b", isolated: true,
    resumable: true, turnsTaken: 1, model: "opus", port: 3101,
    row: {
      id: "s1", label: "auth", project, status: "working", detail: "Bash pnpm test",
      latestReportSeq: null, answeredReportSeq: null,
      startedAt: new Date().toISOString(), tokens: 0, activity: [],
    },
    ...over,
  };
  (registry as any).entries.set("s1", entry);

  return { registry, entry, killed: () => markedWhenKilled };
}

describe("stopping a turn", () => {
  it("marks the exit as asked-for before killing the process", async () => {
    // Marked after the kill is marked too late: the exit can arrive first,
    // and the developer is told "process exited" about something they did.
    const { registry, killed } = await withEntry();
    registry.stop("s1");

    expect(killed()).toBe(true);
  });

  it("kills the process", async () => {
    const { registry, killed } = await withEntry();
    registry.stop("s1");

    expect(killed()).not.toBeNull();
  });

  it("leaves the specialist able to come back", async () => {
    // The turn goes; the worktree, the thread and the memory do not.
    const { registry, entry } = await withEntry();
    registry.stop("s1");

    expect(entry.resumable).toBe(true);
    expect(entry.turnsTaken).toBe(1);
    expect(registry.get("s1")).not.toBeNull();
  });

  it("does nothing for a specialist with no process", async () => {
    const { registry, killed } = await withEntry({ session: null });

    expect(() => registry.stop("s1")).not.toThrow();
    expect(killed()).toBeNull();
    expect(registry.list()[0].status).toBe("working");
  });

  it("does nothing for a specialist that does not exist", async () => {
    const { registry } = await withEntry();
    expect(() => registry.stop("nope")).not.toThrow();
  });
});
