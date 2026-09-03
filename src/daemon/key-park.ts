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
 * It also has to tell "the developer has never touched this switch" apart
 * from "the developer explicitly turned it on". A key typed into Settings is
 * turned on by the act of saving it, but a key Bench finds for itself in the
 * environment or a `.env` should not start spending money nobody chose to
 * spend - it has to wait for that explicit "on" before it is ever handed
 * out. Only an explicit answer, once given, survives a restart either way.
 *
 * Only the flag is written down, never the key. This file holds one boolean
 * and is safe to read - it says a credential is or is not being used, which
 * is the absence of a secret rather than one.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const path = (home: string) => join(home, "keys.json");

/**
 * Whether the key is parked, as of the last time anyone said - or
 * `undefined` when nobody ever has.
 *
 * Anything unreadable, missing or malformed also comes back as `undefined`:
 * a one-boolean file nobody edits by hand should not refuse to start over a
 * typo, and it would be wrong to read a broken file as either a deliberate
 * "on" or a deliberate "off". Callers that need a plain default for "nobody
 * has said" choose it themselves, because that default is not the same for
 * every key - it depends on where the key came from.
 */
export function readParked(home: string): boolean | undefined {
  try {
    const held = JSON.parse(readFileSync(path(home), "utf8")) as { anthropicKeyParked?: unknown };
    if (held?.anthropicKeyParked === true) return true;
    if (held?.anthropicKeyParked === false) return false;
    return undefined;
  } catch {
    return undefined;
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
