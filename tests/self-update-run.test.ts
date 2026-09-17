import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChildProcess } from "node:child_process";
import { runSelfUpdate, type ProcSpawner } from "../src/daemon/self-update-run.js";
import type { GitRunner } from "../src/daemon/self-update-watcher.js";

const home = () => mkdtemp(join(tmpdir(), "bench-update-"));

function fakeGit(answers: Record<string, string | Error>, calls: string[] = []): GitRunner {
  return async (args) => {
    const key = args.join(" ");
    calls.push(key);
    const answer = answers[key];
    if (answer === undefined) throw new Error(`fakeGit: no answer scripted for "${key}"`);
    if (answer instanceof Error) throw answer;
    return { stdout: answer };
  };
}

/** A spawn that never runs a real process - it just reports the exit code
 * the test wants, after emitting on `close` the way a real `ChildProcess`
 * would. */
function fakeSpawner(codeByCommand: Record<string, number>): ProcSpawner {
  return (cmd, args) => {
    const child = new EventEmitter() as unknown as ChildProcess;
    (child as any).stdout = new EventEmitter();
    (child as any).stderr = new EventEmitter();
    (child as any).kill = vi.fn();
    const key = `${cmd} ${args.join(" ")}`;
    const code = codeByCommand[key] ?? 0;
    queueMicrotask(() => child.emit("close", code));
    return child;
  };
}

const CLEAN_UP_TO_DATE = {
  "status --porcelain": "",
  "rev-parse --abbrev-ref HEAD": "main",
  "rev-parse HEAD": "sha-old",
  "fetch --quiet origin main": "",
  "merge-base --is-ancestor HEAD origin/main": "",
  "merge --ff-only origin/main": "",
};

describe("runSelfUpdate", () => {
  it("refuses a dirty tree before touching git at all", async () => {
    const calls: string[] = [];
    const git = fakeGit({ "status --porcelain": " M src/daemon/index.ts\n" }, calls);
    const result = await runSelfUpdate({ root: "/repo", home: await home(), git });

    expect(result).toEqual({ ok: false, error: "the checkout has uncommitted changes" });
    // Only the check itself ran - never a fetch, never a merge.
    expect(calls).toEqual(["status --porcelain"]);
  });

  it("refuses a merge that would not fast-forward, and never merges", async () => {
    const calls: string[] = [];
    const git = fakeGit({
      "status --porcelain": "",
      "rev-parse --abbrev-ref HEAD": "main",
      "rev-parse HEAD": "sha-old",
      "fetch --quiet origin main": "",
      "merge-base --is-ancestor HEAD origin/main": new Error("not an ancestor"),
    }, calls);

    const result = await runSelfUpdate({ root: "/repo", home: await home(), git });

    expect(result).toEqual({ ok: false, error: "the branch has diverged from its remote and cannot fast-forward" });
    expect(calls).not.toContain("merge --ff-only origin/main");
  });

  it("reports a fetch failure by its own message, rather than a generic refusal", async () => {
    const git = fakeGit({
      "status --porcelain": "",
      "rev-parse --abbrev-ref HEAD": "main",
      "rev-parse HEAD": "sha-old",
      "fetch --quiet origin main": new Error("Could not resolve host"),
    });

    const result = await runSelfUpdate({ root: "/repo", home: await home(), git });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Could not resolve host/);
  });

  it("merges and builds, and skips install when the lockfile did not change", async () => {
    const spawnCalls: string[] = [];
    const spawnProc: ProcSpawner = (cmd, args, cwd) => {
      spawnCalls.push(`${cmd} ${args.join(" ")}`);
      return fakeSpawner({ "pnpm build": 0 })(cmd, args, cwd);
    };
    const git = fakeGit({
      ...CLEAN_UP_TO_DATE,
      "rev-parse HEAD": "sha-old", // reused below via a stateful override
    });
    // rev-parse HEAD must answer differently before and after the merge -
    // "sha-old" while checking what to roll back to, "sha-new" once the
    // merge has actually moved HEAD.
    let headCalls = 0;
    const statefulGit: GitRunner = async (args) => {
      if (args.join(" ") === "rev-parse HEAD") {
        headCalls += 1;
        return { stdout: headCalls === 1 ? "sha-old" : "sha-new" };
      }
      if (args.join(" ") === "diff --name-only sha-old..sha-new") return { stdout: "src/daemon/index.ts\n" };
      return git(args, "/repo");
    };

    const result = await runSelfUpdate({ root: "/repo", home: await home(), git: statefulGit, spawnProc });

    expect(result).toEqual({ ok: true });
    expect(spawnCalls).toEqual(["pnpm build"]);
  });

  it("installs first when the pulled range touched the lockfile", async () => {
    const spawnCalls: string[] = [];
    const spawnProc: ProcSpawner = (cmd, args, cwd) => {
      spawnCalls.push(`${cmd} ${args.join(" ")}`);
      return fakeSpawner({ "pnpm install --frozen-lockfile": 0, "pnpm build": 0 })(cmd, args, cwd);
    };
    let headCalls = 0;
    const git: GitRunner = async (args) => {
      const key = args.join(" ");
      if (key === "rev-parse HEAD") { headCalls += 1; return { stdout: headCalls === 1 ? "sha-old" : "sha-new" }; }
      if (key === "diff --name-only sha-old..sha-new") return { stdout: "pnpm-lock.yaml\nsrc/x.ts\n" };
      const answers: Record<string, string> = {
        "status --porcelain": "", "rev-parse --abbrev-ref HEAD": "main",
        "fetch --quiet origin main": "", "merge-base --is-ancestor HEAD origin/main": "",
        "merge --ff-only origin/main": "",
      };
      if (key in answers) return { stdout: answers[key] };
      throw new Error(`unscripted: ${key}`);
    };

    const result = await runSelfUpdate({ root: "/repo", home: await home(), git, spawnProc });

    expect(result).toEqual({ ok: true });
    expect(spawnCalls).toEqual(["pnpm install --frozen-lockfile", "pnpm build"]);
  });

  it("rolls the checkout back to the old HEAD when the build fails, and says so", async () => {
    const resetCalls: string[] = [];
    let headCalls = 0;
    const spawnProc: ProcSpawner = fakeSpawner({ "pnpm build": 1 });
    const home$ = await home();
    const git: GitRunner = async (args) => {
      const key = args.join(" ");
      if (key === "rev-parse HEAD") { headCalls += 1; return { stdout: headCalls === 1 ? "sha-old" : "sha-new" }; }
      if (key === "diff --name-only sha-old..sha-new") return { stdout: "src/x.ts\n" };
      if (key === "reset --hard sha-old") { resetCalls.push(key); return { stdout: "" }; }
      const answers: Record<string, string> = {
        "status --porcelain": "", "rev-parse --abbrev-ref HEAD": "main",
        "fetch --quiet origin main": "", "merge-base --is-ancestor HEAD origin/main": "",
        "merge --ff-only origin/main": "",
      };
      if (key in answers) return { stdout: answers[key] };
      throw new Error(`unscripted: ${key}`);
    };

    const result = await runSelfUpdate({ root: "/repo", home: home$, git, spawnProc });

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/pnpm build failed \(exit 1\)/);
    expect(result.error).toMatch(/sha-old/);
    expect(resetCalls).toEqual(["reset --hard sha-old"]);

    const log = await readFile(join(home$, "update.log"), "utf8");
    expect(log).toContain("pnpm build");
  });

  it("does nothing further when the merge landed no new commits", async () => {
    const spawnProc: ProcSpawner = vi.fn() as unknown as ProcSpawner;
    const git = fakeGit(CLEAN_UP_TO_DATE);

    const result = await runSelfUpdate({ root: "/repo", home: await home(), git, spawnProc });

    expect(result).toEqual({ ok: true });
    expect(spawnProc).not.toHaveBeenCalled();
  });
});
