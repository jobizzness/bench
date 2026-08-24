import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * One daemon per home.
 *
 * Two of them sharing `~/.bench` is not a smaller version of one: they both
 * hold the roster in memory, both rewrite the index, and neither knows the
 * other exists. That is what corrupted an index and emptied a cockpit - and
 * the second daemon could not serve anyway, because the first held the port.
 *
 * The lock is a file with a pid in it. A pid that is no longer running is a
 * daemon that was killed, so the lock is taken rather than honoured: a stale
 * lock that refuses every future start would be a worse failure than the one
 * it prevents.
 */
export class HomeInUse extends Error {
  constructor(readonly pid: number, readonly path: string) {
    super(
      `another Bench daemon (pid ${pid}) is already using this home.\n`
      + `  Stop it first, or start this one with a different BENCH_HOME.\n`
      + `  If that process is gone, delete ${path}.`,
    );
    this.name = "HomeInUse";
  }
}

function running(pid: number): boolean {
  try {
    // Signal 0 asks whether it could be signalled, without signalling it.
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means it exists and belongs to somebody else, which still counts.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function takeHomeLock(home: string): () => void {
  const path = join(home, "daemon.lock");

  let held = 0;
  try {
    held = Number(readFileSync(path, "utf8").trim());
  } catch {
    held = 0;
  }

  if (Number.isInteger(held) && held > 0 && held !== process.pid && running(held)) {
    throw new HomeInUse(held, path);
  }

  mkdirSync(home, { recursive: true });
  writeFileSync(path, `${process.pid}\n`);

  return () => {
    // Only ever remove our own. A daemon shutting down after its lock was
    // taken over must not clear the new one's claim.
    try {
      if (Number(readFileSync(path, "utf8").trim()) === process.pid) rmSync(path);
    } catch {
      // Already gone. Nothing to release.
    }
  };
}
