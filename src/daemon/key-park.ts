/**
 * Whether the developer has parked their Anthropic key, remembered across
 * restarts.
 *
 * The switch beside the key means "bill this to the login this machine
 * already has, not to my key". It worked for as long as the daemon ran and
 * was forgotten the moment it stopped - which did not matter while the key
 * was forgotten at the same time, because a bench with no key has nothing to
 * park.
 *
 * Reading keys from a `.env` broke that symmetry. The key now comes back on
 * every restart and the decision not to spend it did not, so a developer who
 * parked their key on Friday was quietly billing the API again on Monday.
 * A switch that forgets is worse than no switch: the first one you can work
 * around, the second tells you something untrue about where the money is
 * going.
 *
 * Only the flag is written down, never the key. This file holds one boolean
 * and is safe to read - it says a credential is *not* being used, which is
 * the absence of a secret rather than one.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const path = (home: string) => join(home, "keys.json");

/**
 * Whether the key is parked, as of the last time anyone said.
 *
 * Anything unreadable, missing or malformed means "not parked", which is the
 * behaviour Bench had before this file existed. Refusing to start over a
 * one-boolean file nobody edits by hand would be absurd, and defaulting the
 * other way would hide a key that is present and working.
 */
export function readParked(home: string): boolean {
  try {
    const held = JSON.parse(readFileSync(path(home), "utf8")) as { anthropicKeyParked?: unknown };
    return held?.anthropicKeyParked === true;
  } catch {
    return false;
  }
}

/**
 * Write the decision down.
 *
 * Named for what it records rather than for the switch's label, because the
 * switch reads "Use this key" and storing `use: false` inverts the sense of
 * the file every time somebody reads it.
 */
export async function writeParked(home: string, parked: boolean): Promise<void> {
  await mkdir(home, { recursive: true });
  await writeFile(path(home), JSON.stringify({ anthropicKeyParked: parked }, null, 2) + "\n", "utf8");
}
