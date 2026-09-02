import { describe, it, expect } from "vitest";
import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearLaunch, launchEnv, launchPath, readLaunch, recipeFromProc, writeLaunch } from "../src/daemon/launch.js";
import { daemonEnv } from "../src/cli/restart.js";

/**
 * The launch recipe, and what a restart makes of it.
 *
 * These are the parts that can be decided without a process to stop: what is
 * recorded, what is read back, and what environment a new daemon is handed.
 * The rest of a restart is signals and waiting, and is checked by running it
 * - see the manual step on #56.
 */

const home = () => mkdtemp(join(tmpdir(), "bench-launch-"));

describe("the launch recipe", () => {
  it("keeps only Bench's own variables", () => {
    const kept = launchEnv({
      BENCH_LAN: "1",
      BENCH_HOME: "/home/x/.bench",
      PATH: "/usr/bin",
      AWS_SECRET_ACCESS_KEY: "not this",
    });

    expect(kept).toEqual({ BENCH_LAN: "1", BENCH_HOME: "/home/x/.bench" });
  });

  it("drops a variable that is set but empty, rather than recording it as empty", () => {
    expect(launchEnv({ BENCH_LAN: "", BENCH_PORT: "7420" })).toEqual({ BENCH_PORT: "7420" });
  });

  it("round-trips what the daemon was started with", async () => {
    const dir = await home();
    writeLaunch(dir, { pid: 4242, cwd: "/var/www/bench", argv: ["node", "dist/daemon/index.js"], env: { BENCH_LAN: "1" } });

    const back = readLaunch(dir)!;
    expect(back.pid).toBe(4242);
    expect(back.cwd).toBe("/var/www/bench");
    expect(back.argv).toEqual(["node", "dist/daemon/index.js"]);
    expect(back.env).toEqual({ BENCH_LAN: "1" });
    expect(Date.parse(back.startedAt)).not.toBeNaN();
  });

  it("is null where no daemon has ever run, rather than throwing", async () => {
    expect(readLaunch(await home())).toBeNull();
  });

  it("is null when the file is corrupt, so a restart says 'nothing to start' rather than crashing", async () => {
    const dir = await home();
    await writeFile(launchPath(dir), "{ not json");

    expect(readLaunch(dir)).toBeNull();
  });

  it("is null when the file is well-formed but has no argv to run", async () => {
    const dir = await home();
    await writeFile(launchPath(dir), JSON.stringify({ pid: 1, cwd: "/x", argv: [] }));

    expect(readLaunch(dir)).toBeNull();
  });

  it("is removed by the daemon that wrote it", async () => {
    const dir = await home();
    writeLaunch(dir, { pid: 7, cwd: "/x", argv: ["node", "i.js"], env: {} });

    clearLaunch(dir, 7);

    expect(existsSync(launchPath(dir))).toBe(false);
  });

  /* The same rule the lock has, for the same reason: a daemon shutting down
   * after another took the home over must not erase the new one's record. */
  it("is left alone by a daemon that is not the one it names", async () => {
    const dir = await home();
    writeLaunch(dir, { pid: 7, cwd: "/x", argv: ["node", "i.js"], env: {} });

    clearLaunch(dir, 999);

    expect(readLaunch(dir)?.pid).toBe(7);
    expect(JSON.parse(await readFile(launchPath(dir), "utf8")).pid).toBe(7);
  });
});

describe("the environment a restarted daemon is given", () => {
  const recipe = { pid: 1, cwd: "/x", argv: ["node", "i.js"], env: { BENCH_LAN: "1" }, startedAt: "" };

  it("carries the recipe's own variables", () => {
    expect(daemonEnv(recipe, { PATH: "/usr/bin" }).BENCH_LAN).toBe("1");
  });

  it("keeps everything that is not Bench's", () => {
    expect(daemonEnv(recipe, { PATH: "/usr/bin", HOME: "/home/x" })).toMatchObject({
      PATH: "/usr/bin", HOME: "/home/x",
    });
  });

  /* The restart is usually typed by a specialist, whose shell is full of
   * BENCH_ variables describing *it*. A daemon that inherited BENCH_SESSION_ID
   * would be a daemon that thinks it is a specialist. */
  it("drops the calling specialist's own variables", () => {
    const env = daemonEnv(recipe, { BENCH_SESSION_ID: "abc", BENCH_SELF_MODEL: "opus", PATH: "/usr/bin" });

    expect(env.BENCH_SESSION_ID).toBeUndefined();
    expect(env.BENCH_SELF_MODEL).toBeUndefined();
    expect(env.PATH).toBe("/usr/bin");
  });

  it("prefers the recipe over whatever the caller happened to have set", () => {
    const env = daemonEnv(recipe, { BENCH_LAN: "0", BENCH_PORT: "9999" });

    expect(env.BENCH_LAN).toBe("1");
    // Not in the recipe, so it does not survive: the daemon ran without it.
    expect(env.BENCH_PORT).toBeUndefined();
  });
});

describe("reading a recipe off a daemon that never wrote one", () => {
  /* Every daemon running when this landed has a lock and no recipe. Refusing
   * those would mean restart only works after a manual restart, which is the
   * thing it exists to replace. */
  async function fakeProc(pid: number, cmdline: string[], environ: string[], cwd: string): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "bench-proc-"));
    const dir = join(root, String(pid));
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "cmdline"), cmdline.join("\0") + "\0");
    await writeFile(join(dir, "environ"), environ.join("\0") + "\0");
    await symlink(cwd, join(dir, "cwd"));
    return root;
  }

  it("reads the command line, the cwd, and Bench's own variables", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "bench-cwd-"));
    const root = await fakeProc(99, ["node", "dist/daemon/index.js"],
      ["BENCH_LAN=1", "PATH=/usr/bin", "SECRET=no"], cwd);

    const recipe = recipeFromProc(99, root)!;

    expect(recipe.argv).toEqual(["node", "dist/daemon/index.js"]);
    expect(recipe.cwd).toBe(cwd);
    expect(recipe.env).toEqual({ BENCH_LAN: "1" });
  });

  it("is null for a pid with nothing behind it", async () => {
    expect(recipeFromProc(1234, await mkdtemp(join(tmpdir(), "bench-proc-")))).toBeNull();
  });

  it("is null when there is no command line to run again", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "bench-cwd-"));
    const root = await fakeProc(7, [], ["BENCH_LAN=1"], cwd);

    expect(recipeFromProc(7, root)).toBeNull();
  });
});
