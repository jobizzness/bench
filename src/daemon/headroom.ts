import { spawn, type ChildProcess } from "node:child_process";
import { accessSync, constants, createWriteStream, mkdirSync, type WriteStream } from "node:fs";
import { delimiter, dirname, join } from "node:path";

export const DEFAULT_HEADROOM_PORT = 8787;

/**
 * Where the proxy answers "are you up". `/health` is the aggregate endpoint
 * the CLI's own `wrap` command polls, and it answers 2xx only once the proxy
 * is actually ready to take traffic - `/livez` would say yes earlier and mean
 * less.
 */
const HEALTH_PATH = "/health";

const POLL_MS = 250;

/**
 * The headroom binary to spawn, or null when there is none.
 *
 * `BENCH_HEADROOM_BIN` is an override, not a hint: a path named there that
 * does not execute is a misconfiguration worth reporting as absent, not a
 * reason to go quietly find a different binary on PATH and pretend it was
 * the one asked for.
 */
export function findHeadroom(env = process.env): string | null {
  const named = env.BENCH_HEADROOM_BIN;
  if (named !== undefined) return executable(named) ? named : null;

  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (dir === "") continue;
    const candidate = join(dir, "headroom");
    if (executable(candidate)) return candidate;
  }
  return null;
}

function executable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export type HeadroomState = "off" | "absent" | "starting" | "up" | "failed";

/**
 * Bench's handle on a `headroom proxy` process.
 *
 * Three lives, not two: the proxy may be one this daemon spawned (and so has
 * to kill on shutdown), one the developer runs themselves (reused, and
 * deliberately never killed - stopping a daemon must not take down a service
 * it did not start), or absent entirely, which is a normal way for a bench to
 * be rather than an error. Nothing here throws: a compression proxy that
 * will not start leaves specialists running direct, which is what they did
 * before it existed.
 */
export class HeadroomProxy {
  private current: HeadroomState = "off";
  private child: ChildProcess | null = null;
  /** Whether the running proxy is ours to kill. A reused one is not. */
  private owned = false;
  private failure: string | null = null;
  private starting: Promise<void> | null = null;
  private readonly fetchImpl: typeof fetch;
  private readonly startupTimeoutMs: number;

  constructor(private readonly opts: {
    bin: string | null;
    port: number;
    logPath: string;
    fetchImpl?: typeof fetch;
    startupTimeoutMs?: number;
  }) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.startupTimeoutMs = opts.startupTimeoutMs ?? 15_000;
  }

  get state(): HeadroomState {
    return this.current;
  }

  /** The last thing a failed proxy said on stderr, when it said anything. */
  get reason(): string | null {
    return this.failure;
  }

  get installed(): boolean {
    return this.opts.bin !== null;
  }

  /** The base URL to hand a specialist, or null whenever there is no proxy to point it at. */
  url(): string | null {
    return this.current === "up" ? `http://127.0.0.1:${this.opts.port}` : null;
  }

  async start(): Promise<void> {
    // A second caller waits on the same attempt rather than racing a second
    // spawn at the same port. A failed attempt is not cached - the settings
    // flip that calls this again is exactly the "I fixed it, try again"
    // case, and a stale resolved promise would make it a no-op.
    if (this.starting === null || this.current === "failed") {
      this.starting = this.launch().finally(() => {
        if (this.current === "failed") this.starting = null;
      });
    }
    return this.starting;
  }

  private async launch(): Promise<void> {
    if (this.current === "up") return;
    const bin = this.opts.bin;
    if (bin === null) {
      this.current = "absent";
      return;
    }

    // A proxy the developer already runs on this port is used, not fought:
    // spawning a second one would fail on the bind anyway, and killing it on
    // shutdown would take down a service that is not ours.
    if (await this.healthy()) {
      this.current = "up";
      this.owned = false;
      return;
    }

    this.current = "starting";
    this.failure = null;

    mkdirSync(dirname(this.opts.logPath), { recursive: true });
    // Piped rather than fd-shared so the last stderr line stays readable in
    // memory - "it failed" without the line that said why is how this used
    // to report, and it was useless.
    const log: WriteStream = createWriteStream(this.opts.logPath, { flags: "a" });
    const child = spawn(bin, ["proxy", "--port", String(this.opts.port)], {
      env: {
        ...process.env,
        // All-egress-off and beacon-off: a bench whose pitch is that nothing
        // leaves the machine does not get to start a proxy that phones home.
        // HEADROOM_OFFLINE is env-only in headroom - there is no --offline
        // flag, so it has to travel this way rather than in argv.
        HEADROOM_OFFLINE: "true",
        HEADROOM_BEACON: "off",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.child = child;
    this.owned = true;

    let stderrTail = "";
    child.stdout?.on("data", (chunk: Buffer) => log.write(chunk));
    child.stderr?.on("data", (chunk: Buffer) => {
      log.write(chunk);
      stderrTail = (stderrTail + chunk.toString("utf8")).slice(-4000);
    });

    const exited = new Promise<number | null>((resolve) => {
      child.once("exit", (code) => resolve(code));
      child.once("error", (error) => {
        stderrTail = `${stderrTail}${String(error)}\n`;
        resolve(null);
      });
    });

    const deadline = Date.now() + this.startupTimeoutMs;
    while (Date.now() < deadline) {
      if (await this.healthy()) {
        this.current = "up";
        // If our proxy dies later the state has to say so - a URL that is
        // still handed out while nothing listens is worse than none.
        void exited.then((code) => {
          if (this.current === "up") {
            this.current = "failed";
            this.failure = this.lastLine(stderrTail) ?? `proxy exited with code ${code ?? "?"}`;
          }
        });
        return;
      }
      const code = await Promise.race([exited, sleep(POLL_MS).then(() => "wait" as const)]);
      if (code !== "wait") {
        this.current = "failed";
        this.failure = this.lastLine(stderrTail) ?? `proxy exited with code ${code ?? "?"}`;
        return;
      }
    }

    this.current = "failed";
    this.failure = this.lastLine(stderrTail) ?? `no answer on ${HEALTH_PATH} within ${this.startupTimeoutMs}ms`;
  }

  /** Last non-empty line of what the proxy wrote to stderr. */
  private lastLine(stderr: string): string | null {
    const lines = stderr.trim().split("\n").map((l) => l.trim()).filter((l) => l !== "");
    return lines.at(-1) ?? null;
  }

  private async healthy(): Promise<boolean> {
    try {
      const res = await this.fetchImpl(`http://127.0.0.1:${this.opts.port}${HEALTH_PATH}`, {
        signal: AbortSignal.timeout(1000),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  stop(): void {
    // Owned only. A reused proxy outlives the daemon that borrowed it.
    if (!this.owned || !this.child) return;
    this.child.kill("SIGTERM");
    this.child = null;
    this.owned = false;
    this.current = "off";
    this.starting = null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
