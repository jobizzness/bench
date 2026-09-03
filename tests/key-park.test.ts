import { describe, it, expect } from "vitest";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readParked, writeParked } from "../src/daemon/key-park.js";

/**
 * The switch beside the Anthropic key, remembered.
 *
 * It means "bill this to the login this machine already has, not to my key",
 * and it used to last exactly as long as the daemon. That was harmless while
 * the key was forgotten at the same moment - a bench with no key has nothing
 * to park. Reading keys from a `.env` broke the symmetry: the key came back
 * on every restart and the decision not to spend it did not, so a developer
 * who parked their key on Friday was billing the API again on Monday without
 * being told.
 */

async function home() {
  return mkdtemp(join(tmpdir(), "bench-park-"));
}

describe("remembering that a key is parked", () => {
  it("says nothing when nobody has ever said", async () => {
    // Neither "on" nor "off" - a default that differs by where the key came
    // from, and is not this file's to pick.
    expect(readParked(await home())).toBeUndefined();
  });

  it("comes back the way it was left", async () => {
    const dir = await home();

    await writeParked(dir, true);
    expect(readParked(dir)).toBe(true);

    await writeParked(dir, false);
    expect(readParked(dir)).toBe(false);
  });

  it("reads a file that is not what it expected as nobody having said", async () => {
    // One boolean nobody edits by hand. Refusing to start over it would be
    // absurd, and a daemon that will not come up is worse than a switch that
    // forgot - but a broken file is not a deliberate answer either, so it
    // reads the same as no file at all.
    const dir = await home();
    await writeFile(join(dir, "keys.json"), "{ this is not json", "utf8");
    expect(readParked(dir)).toBeUndefined();

    await writeFile(join(dir, "keys.json"), '{"somethingElse":true}', "utf8");
    expect(readParked(dir)).toBeUndefined();
  });

  it("writes down the flag and never the key", async () => {
    // This file says a credential is *not* being used, which is the absence
    // of a secret rather than one. It has to stay that way.
    const dir = await home();
    await writeParked(dir, true);

    const text = await readFile(join(dir, "keys.json"), "utf8");
    expect(JSON.parse(text)).toEqual({ anthropicKeyParked: true });
    expect(text).not.toMatch(/sk-ant|sk-or/);
  });

  it("makes the home directory if it is not there yet", async () => {
    // The switch can be thrown before anything else has written to a fresh
    // home, and failing there would lose the developer's answer.
    const dir = join(await home(), "not", "yet");
    await writeParked(dir, true);
    expect(readParked(dir)).toBe(true);
  });
});
