import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * What `~/.bench/firebase.json` holds: the credential that lets this daemon
 * keep acting as the developer's Google account, and the id this machine
 * chose for itself the first time remote was turned on.
 *
 * Mode 0600, the same treatment `~/.bench/token` gets in `token.ts` - this
 * file is a bearer credential for a Google account, not just for this
 * machine.
 */
export interface RemoteIdentity {
  uid: string;
  refreshToken: string;
  /** Minted once, on the first connection, and kept stable across restarts
   * and renames - see machine.ts for the document this id names. */
  machineId: string;
  /** The address the cockpit showed at sign-in, for "which account is
   * connected" in Settings. Cosmetic only - the rules gate on `uid`, never
   * on this - so a missing one (an older file, from before this field
   * existed) just means Settings shows the uid instead. */
  email?: string;
}

function identityPath(home: string): string {
  return join(home, "firebase.json");
}

/** `null` when remote has never been turned on, or has been turned off. */
export function loadIdentity(home: string): RemoteIdentity | null {
  try {
    const raw = JSON.parse(readFileSync(identityPath(home), "utf8"));
    if (typeof raw?.uid !== "string" || typeof raw?.refreshToken !== "string" || typeof raw?.machineId !== "string") {
      return null;
    }
    return {
      uid: raw.uid,
      refreshToken: raw.refreshToken,
      machineId: raw.machineId,
      ...(typeof raw.email === "string" ? { email: raw.email } : {}),
    };
  } catch {
    return null;
  }
}

export function saveIdentity(home: string, identity: RemoteIdentity): void {
  mkdirSync(home, { recursive: true });
  const path = identityPath(home);
  writeFileSync(path, JSON.stringify(identity, null, 2) + "\n", { mode: 0o600 });
  // writeFileSync only applies mode when it creates the file - an existing
  // file (a refreshed token, a renamed machine) keeps whatever mode it had.
  chmodSync(path, 0o600);
}

export function clearIdentity(home: string): void {
  try {
    rmSync(identityPath(home));
  } catch {
    // Already gone - "forget it" was already true.
  }
}

/** 18 bytes of randomness, base64url: short enough to read in a log line,
 * long enough that two laptops never collide. */
export function mintMachineId(): string {
  return randomBytes(18).toString("base64url");
}
