import { describe, it, expect, vi } from "vitest";
import { SelfUpdateWatcher, type GitRunner } from "../src/daemon/self-update-watcher.js";

const BOOT = "boot0000";

/** A fake `git`, driven by a script of answers keyed on the joined args -
 * the same shape the real one would be called with, so the watcher's own
 * argument choices are exercised rather than assumed. */
function fakeGit(answers: Record<string, string | Error>): GitRunner {
  return async (args) => {
    const key = args.join(" ");
    const answer = answers[key];
    if (answer === undefined) throw new Error(`fakeGit: no answer scripted for "${key}"`);
    if (answer instanceof Error) throw answer;
    return { stdout: answer };
  };
}

const LEVEL = {
  "rev-parse HEAD": BOOT,
  "status --porcelain --untracked-files=no": "",
  "fetch --quiet origin main": "",
  "rev-list --count HEAD..origin/main": "0",
  "merge-base --is-ancestor boot0000 origin/main": "",
};

function rig(answers: Record<string, string | Error>) {
  const onChange = vi.fn();
  const watcher = new SelfUpdateWatcher({
    root: "/repo", bootSha: BOOT, branch: "main", onChange,
    git: fakeGit(answers),
    log: () => {},
    setIntervalImpl: (() => 0) as unknown as typeof setInterval,
    clearIntervalImpl: (() => {}) as unknown as typeof clearInterval,
  });
  return { watcher, onChange };
}

describe("SelfUpdateWatcher", () => {
  it("starts level with origin and pushes once", async () => {
    const { watcher, onChange } = rig(LEVEL);
    await watcher.tick();
    expect(watcher.current()).toEqual({ action: { kind: "none" }, fetchError: null });
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("reports blocked/dirty when a tracked file is actually modified", async () => {
    const { watcher } = rig({
      ...LEVEL,
      "status --porcelain --untracked-files=no": " M src/daemon/index.ts\n",
      "rev-list --count HEAD..origin/main": "3",
      "merge-base --is-ancestor boot0000 origin/main": "",
    });
    await watcher.tick();
    expect(watcher.current().action).toEqual({ kind: "blocked", reason: "dirty" });
  });

  it("does not report blocked/dirty for an untracked file - agrees with what the route would do (#149)", async () => {
    // `LEVEL` only answers `status --porcelain --untracked-files=no`, empty -
    // asking git to leave untracked files out is what a real untracked file
    // (e.g. a stray `node_modules` symlink) would never show up in. If the
    // watcher fell back to plain `status --porcelain` this would throw with
    // "no answer scripted" instead of reaching the assertion below.
    const { watcher, onChange } = rig({
      ...LEVEL,
      "rev-list --count HEAD..origin/main": "3",
      "merge-base --is-ancestor boot0000 origin/main": "",
    });
    await watcher.tick();
    expect(watcher.current().action).toEqual({ kind: "update", behind: 3 });
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("notices a remote that moved", async () => {
    const { watcher, onChange } = rig({
      ...LEVEL,
      "rev-list --count HEAD..origin/main": "3",
      "merge-base --is-ancestor boot0000 origin/main": "",
    });
    await watcher.tick();
    expect(watcher.current().action).toEqual({ kind: "update", behind: 3 });
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("notices a fetch that failed, and does not report the checkout as level with origin", async () => {
    const { watcher, onChange } = rig({
      "rev-parse HEAD": BOOT,
      "status --porcelain --untracked-files=no": "",
      "fetch --quiet origin main": new Error("Could not resolve host: github.com"),
    });
    await watcher.tick();
    const status = watcher.current();
    expect(status.fetchError).toMatch(/Could not resolve host/);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("keeps reporting an update as available across a fetch failure, rather than resetting to none", async () => {
    let fetchShouldFail = false;
    const git: GitRunner = async (args) => {
      const key = args.join(" ");
      if (key === "fetch --quiet origin main" && fetchShouldFail) throw new Error("timed out");
      const answers: Record<string, string> = { ...LEVEL, "rev-list --count HEAD..origin/main": "2" };
      return { stdout: answers[key] ?? "" };
    };
    const onChange = vi.fn();
    const watcher = new SelfUpdateWatcher({
      root: "/repo", bootSha: BOOT, branch: "main", onChange, git,
      log: () => {},
      setIntervalImpl: (() => 0) as unknown as typeof setInterval,
      clearIntervalImpl: (() => {}) as unknown as typeof clearInterval,
    });

    await watcher.tick();
    expect(watcher.current().action).toEqual({ kind: "update", behind: 2 });

    fetchShouldFail = true;
    await watcher.tick();
    expect(watcher.current().action).toEqual({ kind: "update", behind: 2 });
    expect(watcher.current().fetchError).toMatch(/timed out/);
  });

  it("does not fire twice for one change - a second tick with the same git state pushes nothing further", async () => {
    const { watcher, onChange } = rig(LEVEL);
    await watcher.tick();
    await watcher.tick();
    await watcher.tick();
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("reports restart once HEAD has moved past the boot commit", async () => {
    const { watcher, onChange } = rig({
      ...LEVEL,
      "rev-parse HEAD": "moved999",
      "merge-base --is-ancestor moved999 origin/main": "",
    });
    await watcher.tick();
    expect(watcher.current().action).toEqual({ kind: "restart" });
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("shares one in-flight tick between overlapping calls", async () => {
    // A real, short delay rather than a manually-resolved promise - `tick()`
    // has to return the same in-flight promise to a second caller before
    // `run()` has had any chance to get past its first `await`, and racing
    // that moment by hand is exactly the kind of test that is flaky for a
    // reason nobody wants to debug twice.
    const git: GitRunner = async (args) => {
      const key = args.join(" ");
      if (key === "fetch --quiet origin main") await new Promise((r) => setTimeout(r, 20));
      const answers: Record<string, string> = { ...LEVEL };
      return { stdout: answers[key] ?? "" };
    };
    const onChange = vi.fn();
    const watcher = new SelfUpdateWatcher({
      root: "/repo", bootSha: BOOT, branch: "main", onChange, git,
      setIntervalImpl: (() => 0) as unknown as typeof setInterval,
      clearIntervalImpl: (() => {}) as unknown as typeof clearInterval,
    });

    const first = watcher.tick();
    const second = watcher.tick();
    expect(second).toBe(first);
    await first;
    expect(onChange).toHaveBeenCalledTimes(1);
  });
});
