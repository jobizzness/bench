import { homedir } from "node:os";
import { loadToken } from "./token.js";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

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
    pluginDir: join(root, "plugin"),
    hookCommand: `node ${join(root, "dist", "daemon", "hooks", "bench-hook.js")}`,
  };
}
