import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionRegistry } from "../src/daemon/registry.js";

/**
 * clearContext has the same contract as stop(): mark before you kill, so an
 * exit that follows reads as a decision rather than a crash. What is
 * different, and what these assert, is what gets dropped - the conversation,
 * not the turn - and that the thread says so.
 */
async function withEntry(over: Record<string, unknown> = {}) {
  const home = await mkdtemp(join(tmpdir(), "bench-clear-"));
  const project = await mkdtemp(join(tmpdir(), "bench-clear-p-"));
  const reportsDir = join(project, ".bench", "reports", "s1");
  await mkdir(reportsDir, { recursive: true });
  const threadPath = join(reportsDir, "thread.jsonl");
  await writeFile(threadPath, "");

  const registry = new SessionRegistry({
    home, host: "127.0.0.1", port: 7420, token: "t",
    pluginDir: "/nonexistent", hookCommand: "true", projectsRoot: project,
  } as any);

  let markedWhenKilled: boolean | null = null;

  const entry: Record<string, unknown> = {
    reportsDir,
    threadPath,
    session: {
      stop() {
        markedWhenKilled = (registry as any).entries.get("s1").stopping === true;
      },
    },
    alive: true, worktree: project, branch: "b", isolated: true,
    resumable: true, turnsTaken: 3, model: "opus", port: 3101,
    row: {
      id: "s1", label: "auth", project, status: "working", detail: "Bash pnpm test",
      latestReportSeq: null, answeredReportSeq: null, context: { used: 190_000, window: 200_000 },
      startedAt: new Date().toISOString(), tokens: 0, activity: [],
    },
    ...over,
  };
  (registry as any).entries.set("s1", entry);

  return { registry, entry, threadPath, reportsDir, killed: () => markedWhenKilled };
}

describe("clearing a specialist's context", () => {
  it("marks the exit as asked-for before killing the process", async () => {
    const { registry, killed } = await withEntry();
    registry.clearContext("s1");

    expect(killed()).toBe(true);
  });

  it("says why, so the row does not read as a crash", async () => {
    const { registry, entry } = await withEntry();
    registry.clearContext("s1");

    expect((entry as any).stoppedBecause).toBe("context cleared");
  });

  it("drops the conversation but leaves the specialist able to come back", async () => {
    // The worktree and branch are untouched; the turn count advances by one
    // to reserve the slot the clear-context report claims, the same way a
    // real turn would, so the next real turn cannot write over it.
    const { registry, entry } = await withEntry();
    registry.clearContext("s1");

    expect((entry as any).resumable).toBe(false);
    expect((entry as any).turnsTaken).toBe(4);
    expect(registry.get("s1")).not.toBeNull();
  });

  it("clears the context reading on the row", async () => {
    const { registry, entry } = await withEntry();
    registry.clearContext("s1");

    expect((entry.row as any).context).toBeNull();
  });

  it("records what happened on the thread, so a specialist that suddenly remembers nothing does not look broken", async () => {
    const { registry, threadPath } = await withEntry();
    registry.clearContext("s1");

    // The system line is written synchronously; the report line follows once
    // the summary has actually been written to disk. Poll for both.
    let lines: string[] = [];
    for (let i = 0; i < 50 && lines.length < 2; i++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      lines = (await readFile(threadPath, "utf8")).trim().split("\n").filter(Boolean);
    }
    const parsed = lines.map((line) => JSON.parse(line));

    const system = parsed.find((entry) => entry.kind === "system");
    expect(system?.body).toContain("Context cleared");

    const report = parsed.find((entry) => entry.kind === "report");
    expect(report?.body).toBe("Context cleared");
    expect(report?.reportSeq).toBe(4);
  });

  it("does nothing for a specialist with no process, beyond announcing the roster", async () => {
    const { registry, entry, killed } = await withEntry({ session: null });
    let announced = false;
    registry.once("roster", () => { announced = true; });

    registry.clearContext("s1");

    expect(killed()).toBeNull();
    expect((entry as any).resumable).toBe(false);
    expect(announced).toBe(true);
  });

  it("does nothing for a specialist that does not exist", async () => {
    const { registry } = await withEntry();
    expect(registry.clearContext("nope")).toBe(false);
  });

  it("says whether it found the specialist", async () => {
    const { registry } = await withEntry();
    expect(registry.clearContext("s1")).toBe(true);
  });

  it("increments clearCount on each clearContext and builds a summary of the thread", async () => {
    const { registry, entry, threadPath, reportsDir } = await withEntry();
    await writeFile(threadPath, [
      JSON.stringify({ kind: "user", body: "Hello from developer" }),
      JSON.stringify({ kind: "reply", body: "Hello from specialist" }),
    ].join("\n") + "\n");

    expect((entry as any).clearCount).toBeUndefined();
    registry.clearContext("s1");

    expect((entry as any).clearCount).toBe(1);

    // Wait for the background report to actually land on disk.
    let html = "";
    for (let i = 0; i < 50 && html === ""; i++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      html = await readFile(join(reportsDir, "4", "report.html"), "utf8").catch(() => "");
    }

    expect((entry as any).threadSummary).toContain("CHRONOLOGICAL SUMMARY");
    expect((entry as any).threadSummary).toContain("Developer: Hello from developer");
    expect((entry as any).threadSummary).toContain("Specialist: Hello from specialist");

    // The report itself, in the developer's terms, has no LLM-facing framing.
    expect(html).not.toContain("CHRONOLOGICAL SUMMARY");
    expect(html).toContain("Hello from developer");
    expect(html).toContain("Hello from specialist");
    expect(html).toContain("Context cleared (version 1)");

    const decision = JSON.parse(await readFile(join(reportsDir, "4", "decision.json"), "utf8"));
    expect(decision.kind).toBe("completion");

    expect((entry as any).row.latestReportSeq).toBe(4);
  });
});
