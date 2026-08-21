import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export interface BenchConfig {
  home: string;
  port: number;
  token: string;
  pluginDir: string;
  hookCommand: string;
}

export function loadConfig(): BenchConfig {
  const home = process.env.BENCH_HOME ?? join(homedir(), ".bench");
  const port = Number(process.env.BENCH_PORT ?? "7420");
  const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

  return {
    home,
    port,
    token: randomBytes(24).toString("hex"),
    pluginDir: join(root, "plugin"),
    hookCommand: `node ${join(root, "dist", "daemon", "hooks", "bench-hook.js")}`,
  };
}
