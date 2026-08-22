import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The cockpit's token, kept across restarts.
 *
 * Minting a new one every boot meant every restart silently invalidated
 * whatever the developer had open: the page still served, the socket was
 * refused, and the roster sat empty as though every specialist had vanished.
 *
 * The daemon binds to 127.0.0.1 only, so persisting this does not widen what
 * can reach it - it moves the secret from "reprinted on every boot" to a file
 * only its owner can read. Delete the file to rotate.
 */
export function loadToken(home: string): string {
  const fromEnv = process.env.BENCH_TOKEN?.trim();
  if (fromEnv) return fromEnv;

  const path = join(home, "token");
  try {
    const existing = readFileSync(path, "utf8").trim();
    if (existing !== "") return existing;
  } catch {
    // No token yet, or unreadable. Either way, mint one.
  }

  const token = randomBytes(24).toString("hex");
  mkdirSync(home, { recursive: true });
  writeFileSync(path, token + "\n", { mode: 0o600 });
  // writeFileSync only applies mode when it creates the file.
  chmodSync(path, 0o600);
  return token;
}
