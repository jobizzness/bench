import { homedir } from "node:os";
import { loadToken } from "./token.js";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export interface BenchConfig {
  home: string;
  port: number;
  token: string;
  pluginDir: string;
  hookCommand: string;
  projectsRoot: string;
}

export function loadConfig(): BenchConfig {
  const home = process.env.BENCH_HOME ?? join(homedir(), ".bench");
  const port = Number(process.env.BENCH_PORT ?? "7420");
  const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

  return {
    home,
    port,
    projectsRoot: process.env.BENCH_PROJECTS_ROOT ?? "/var/www",
    token: loadToken(home),
    pluginDir: join(root, "plugin"),
    hookCommand: `node ${join(root, "dist", "daemon", "hooks", "bench-hook.js")}`,
  };
}
