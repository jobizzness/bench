import { describe, it, expect } from "vitest";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HomeInUse, takeHomeLock } from "../src/daemon/lock.js";

const home = () => mkdtemp(join(tmpdir(), "bench-lock-"));

/** A pid that is certainly not running: above the kernel's maximum. */
const GONE = 4_194_305;

describe("the home lock", () => {
  it("lets a daemon claim a home nobody is using", async () => {
    const dir = await home();
    const release = takeHomeLock(dir);
    expect((await readFile(join(dir, "daemon.lock"), "utf8")).trim()).toBe(String(process.pid));
    release();
  });

  it("turns a second daemon away from a home already in use", async () => {
    // Two daemons on one home hold two rosters and write the same index over
    // each other. That corrupted a real one, and the second could not have
    // served anyway - the first has the port.
    const dir = await home();
    // Somebody else's pid, and one that is definitely alive.
    await writeFile(join(dir, "daemon.lock"), `${process.ppid}\n`);

    expect(() => takeHomeLock(dir)).toThrow(HomeInUse);
  });

  it("takes over a lock whose daemon is gone", async () => {
    // A killed daemon leaves its lock behind. Honouring that forever would
    // be a worse failure than the one the lock prevents.
    const dir = await home();
    await writeFile(join(dir, "daemon.lock"), `${GONE}\n`);

    const release = takeHomeLock(dir);
    expect((await readFile(join(dir, "daemon.lock"), "utf8")).trim()).toBe(String(process.pid));
    release();
  });

  it("leaves a lock that was taken over by someone else alone", async () => {
    const dir = await home();
    const release = takeHomeLock(dir);
    await writeFile(join(dir, "daemon.lock"), `${process.ppid}\n`);

    release();

    expect((await readFile(join(dir, "daemon.lock"), "utf8")).trim()).toBe(String(process.ppid));
  });

  it("says which process is holding it and how to get out", async () => {
    const dir = await home();
    await writeFile(join(dir, "daemon.lock"), `${process.ppid}\n`);

    try {
      takeHomeLock(dir);
      expect.unreachable("should have refused");
    } catch (error) {
      expect(String(error)).toContain(String(process.ppid));
      expect(String(error)).toContain(join(dir, "daemon.lock"));
      expect(String(error)).toContain("BENCH_HOME");
    }
  });
});
