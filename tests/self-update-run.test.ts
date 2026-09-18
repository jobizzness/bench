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

/**
 * A spawn that never runs a real process - it just reports the exit code the
 * test wants, after emitting on `close` the way a real `ChildProcess` would.
 *
 * Each command may script more than one code, consumed in order - the
 * recovery path (#146 review) runs `pnpm install`/`pnpm build` a second time
 * after a rollback, and a test proving the recovery build succeeds where the
 * original one failed needs the same key to answer differently twice. The
 * one function instance returned here must be reused across calls (not
 * reconstructed per call) for that queue to mean anything.
 */
function fakeSpawner(codesByCommand: Record<string, number | number[]>): ProcSpawner {
  const queues: Record<string, number[]> = Object.fromEntries(
    Object.entries(codesByCommand).map(([k, v]) => [k, Array.isArray(v) ? [...v] : [v]]),
  );
  return (cmd, args) => {
    const child = new EventEmitter() as unknown as ChildProcess;
    (child as any).stdout = new EventEmitter();
    (child as any).stderr = new EventEmitter();
    (child as any).kill = vi.fn();
    const key = `${cmd} ${args.join(" ")}`;
    const queue = queues[key];
    const code = queue && queue.length > 0 ? queue.shift()! : 0;
    queueMicrotask(() => child.emit("close", code));
    return child;
  };
}

const CLEAN_UP_TO_DATE = {
  "status --porcelain --untracked-files=no": "",
  "rev-parse --abbrev-ref HEAD": "main",
  "rev-parse HEAD": "sha-old",
  "fetch --quiet origin main": "",
  "merge-base --is-ancestor HEAD origin/main": "",
  "merge --ff-only origin/main": "",
};

describe("runSelfUpdate", () => {
  it("refuses a dirty tree before touching git at all", async () => {
    const calls: string[] = [];
    const git = fakeGit({ "status --porcelain --untracked-files=no": " M src/daemon/index.ts\n" }, calls);
    const result = await runSelfUpdate({ root: "/repo", home: await home(), git });

    expect(result).toEqual({ ok: false, error: "the checkout has uncommitted changes" });
    // Only the check itself ran - never a fetch, never a merge.
    expect(calls).toEqual(["status --porcelain --untracked-files=no"]);
  });

  it("does not refuse on an untracked file - only tracked changes block an update", async () => {
    const calls: string[] = [];
    const git = fakeGit({ ...CLEAN_UP_TO_DATE }, calls);

    const result = await runSelfUpdate({ root: "/repo", home: await home(), git });

    expect(result).toEqual({ ok: true });
    // The status check itself asked git to leave untracked files out - an
    // untracked file (e.g. a stray `node_modules` symlink, see #149) never
    // appears in what it answered, so this never had a chance to look dirty.
    expect(calls[0]).toBe("status --porcelain --untracked-files=no");
  });

  it("refuses a merge that would not fast-forward, and never merges", async () => {
    const calls: string[] = [];
    const git = fakeGit({
      "status --porcelain --untracked-files=no": "",
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
      "status --porcelain --untracked-files=no": "",
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
        "status --porcelain --untracked-files=no": "", "rev-parse --abbrev-ref HEAD": "main",
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

  /** A git double for the rollback tests below: everything up to the build
   * step behaves, with no lockfile change in the pulled range, and answers
   * `reset --hard sha-old` so the recovery path can actually run against it. */
  function rollbackGit(resetCalls: string[]): GitRunner {
    let headCalls = 0;
    return async (args) => {
      const key = args.join(" ");
      if (key === "rev-parse HEAD") { headCalls += 1; return { stdout: headCalls === 1 ? "sha-old" : "sha-new" }; }
      if (key === "diff --name-only sha-old..sha-new") return { stdout: "src/x.ts\n" };
      if (key === "reset --hard sha-old") { resetCalls.push(key); return { stdout: "" }; }
      const answers: Record<string, string> = {
        "status --porcelain --untracked-files=no": "", "rev-parse --abbrev-ref HEAD": "main",
        "fetch --quiet origin main": "", "merge-base --is-ancestor HEAD origin/main": "",
        "merge --ff-only origin/main": "",
      };
      if (key in answers) return { stdout: answers[key] };
      throw new Error(`unscripted: ${key}`);
    };
  }

  it("rolls the checkout back to the old HEAD when the build fails, and says so", async () => {
    const resetCalls: string[] = [];
    const home$ = await home();
    // The recovery rebuild (run against the now-reverted source) succeeds -
    // this is the ordinary case: whatever broke the build was in the
    // commits just rolled back out of.
    const spawnProc = fakeSpawner({ "pnpm build": [1, 0] });

    const result = await runSelfUpdate({ root: "/repo", home: home$, git: rollbackGit(resetCalls), spawnProc });

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/pnpm build failed \(exit 1\)/);
    expect(result.error).toMatch(/rolled the checkout back to sha-old/);
    expect(result.error).toMatch(/rebuilt/);
    expect(resetCalls).toEqual(["reset --hard sha-old"]);

    const log = await readFile(join(home$, "update.log"), "utf8");
    expect(log).toContain("pnpm build");
  });

  it("says the restart will not come back cleanly when even the recovery rebuild fails", async () => {
    const resetCalls: string[] = [];
    // Fails both as the original build and as the recovery rebuild -
    // whatever is wrong is not specific to the commits just pulled.
    const spawnProc = fakeSpawner({ "pnpm build": [1, 1] });

    const result = await runSelfUpdate({ root: "/repo", home: await home(), git: rollbackGit(resetCalls), spawnProc });

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/dist\/ could not be rebuilt/);
    expect(result.error).toMatch(/will not come back cleanly/);
    expect(resetCalls).toEqual(["reset --hard sha-old"]);
  });

  it("re-installs and rebuilds on rollback when the lockfile had changed, not just the source", async () => {
    const resetCalls: string[] = [];
    let headCalls = 0;
    const spawnCalls: string[] = [];
    const inner = fakeSpawner({ "pnpm install --frozen-lockfile": [0, 0], "pnpm build": [1, 0] });
    const spawnProc: ProcSpawner = (cmd, args, cwd) => { spawnCalls.push(`${cmd} ${args.join(" ")}`); return inner(cmd, args, cwd); };
    const git: GitRunner = async (args) => {
      const key = args.join(" ");
      if (key === "rev-parse HEAD") { headCalls += 1; return { stdout: headCalls === 1 ? "sha-old" : "sha-new" }; }
      if (key === "diff --name-only sha-old..sha-new") return { stdout: "pnpm-lock.yaml\nsrc/x.ts\n" };
      if (key === "reset --hard sha-old") { resetCalls.push(key); return { stdout: "" }; }
      const answers: Record<string, string> = {
        "status --porcelain --untracked-files=no": "", "rev-parse --abbrev-ref HEAD": "main",
        "fetch --quiet origin main": "", "merge-base --is-ancestor HEAD origin/main": "",
        "merge --ff-only origin/main": "",
      };
      if (key in answers) return { stdout: answers[key] };
      throw new Error(`unscripted: ${key}`);
    };

    const result = await runSelfUpdate({ root: "/repo", home: await home(), git, spawnProc });

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/rebuilt/);
    expect(spawnCalls).toEqual([
      "pnpm install --frozen-lockfile", "pnpm build",
      "pnpm install --frozen-lockfile", "pnpm build",
    ]);
  });

  it("says node_modules may not match when the recovery re-install itself fails", async () => {
    const resetCalls: string[] = [];
    let headCalls = 0;
    const spawnProc = fakeSpawner({ "pnpm install --frozen-lockfile": [1, 1] });
    const git: GitRunner = async (args) => {
      const key = args.join(" ");
      if (key === "rev-parse HEAD") { headCalls += 1; return { stdout: headCalls === 1 ? "sha-old" : "sha-new" }; }
      if (key === "diff --name-only sha-old..sha-new") return { stdout: "pnpm-lock.yaml\nsrc/x.ts\n" };
      if (key === "reset --hard sha-old") { resetCalls.push(key); return { stdout: "" }; }
      const answers: Record<string, string> = {
        "status --porcelain --untracked-files=no": "", "rev-parse --abbrev-ref HEAD": "main",
        "fetch --quiet origin main": "", "merge-base --is-ancestor HEAD origin/main": "",
        "merge --ff-only origin/main": "",
      };
      if (key in answers) return { stdout: answers[key] };
      throw new Error(`unscripted: ${key}`);
    };

    const result = await runSelfUpdate({ root: "/repo", home: await home(), git, spawnProc });

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/pnpm install failed \(exit 1\)/);
    expect(result.error).toMatch(/node_modules could not be restored/);
    expect(result.error).toMatch(/may not come back cleanly/);
  });

  it("does nothing further when the merge landed no new commits", async () => {
    const spawnProc: ProcSpawner = vi.fn() as unknown as ProcSpawner;
    const git = fakeGit(CLEAN_UP_TO_DATE);

    const result = await runSelfUpdate({ root: "/repo", home: await home(), git, spawnProc });

    expect(result).toEqual({ ok: true });
    expect(spawnProc).not.toHaveBeenCalled();
  });
});
