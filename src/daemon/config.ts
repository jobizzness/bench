import { homedir } from "node:os";
import { loadToken } from "./token.js";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { findCredentials, type Found } from "./env-file.js";
import { readParked } from "./key-park.js";

export interface BenchConfig {
  home: string;
  /**
   * What the cockpit binds to. Loopback by default: the token is the whole
   * of the authentication, it travels in the URL over plain HTTP, and a
   * specialist has a full shell - so reaching this port is reaching a shell.
   * Widening it is a decision, which is why it is opt-in rather than a
   * default someone inherits without meaning to.
   */
  host: string;
  port: number;
  token: string;
  pluginDir: string;
  hookCommand: string;
  projectsRoot: string;
  /**
   * The CLI to spawn. Only ever set by tests, which cannot let a unit test of
   * the supervisor launch a real agent - and on a machine without the CLI
   * installed, that spawn fails as an unhandled error rather than a test.
   */
  claudeBin?: string;
  /** Where Bench itself is installed. One of the places a `.env` is looked
   * for, so a checkout's own file is read even when the daemon was started
   * from somewhere else. */
  installRoot: string;
  /**
   * The keys Bench found for itself before anything asked for one.
   *
   * Resolved here rather than in the registry because this is the file that
   * is allowed to read the world - and because a registry that reads the
   * real environment in its constructor is a registry whose tests depend on
   * whichever machine runs them. A config without this field is a bench that
   * found nothing, which is exactly what a test wants.
   */
  credentials?: { anthropic: Found | null; router: Found | null; searched: string[] };
  /**
   * Whether the developer had parked their Anthropic key when this daemon
   * last stopped.
   *
   * Read here for the same reason the keys are: a registry that reads the
   * disk in its constructor is a registry whose tests depend on the machine
   * running them. Absent means not parked, which is what Bench did before
   * the flag was written down at all.
   */
  apiKeyParked?: boolean;
}

export function loadConfig(): BenchConfig {
  const home = process.env.BENCH_HOME ?? join(homedir(), ".bench");
  const port = Number(process.env.BENCH_PORT ?? "7420");
  const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

  // BENCH_LAN=1 is the short way to say the thing most people mean; BENCH_HOST
  // is there for anyone who wants to name a single interface instead.
  const host = process.env.BENCH_HOST
    ?? (process.env.BENCH_LAN === "1" ? "0.0.0.0" : "127.0.0.1");

  return {
    home,
    host,
    port,
    projectsRoot: process.env.BENCH_PROJECTS_ROOT ?? "/var/www",
    token: loadToken(home),
    installRoot: root,
    // Read, never merged into `process.env`: a `.env` holds more than Bench
    // understands, and this daemon's environment is spread into every
    // specialist it spawns.
    credentials: findCredentials({ home, installRoot: root }),
    // The switch means "bill this to the machine's own login". It used to be
    // forgotten on restart, which stopped being harmless the moment the key
    // itself started coming back.
    apiKeyParked: readParked(home),
    pluginDir: join(root, "plugin"),
    hookCommand: `node ${join(root, "dist", "daemon", "hooks", "bench-hook.js")}`,
  };
}
