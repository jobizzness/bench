import { describe, it, expect } from "vitest";
import { attempt } from "../editor/vscode/src/retry.js";

/**
 * The edit event rides on the tool call, which the agent sends *before* the
 * tool runs. For an `Edit` the file is already there; for a `Write` creating
 * a new one it is not, and opening it lands on a file that does not exist yet
 * - which is precisely the file the developer most wants to watch appear.
 */
describe("opening a file that may not exist yet", () => {
  const instant = async () => {};

  it("does not wait when the file is already there", async () => {
    let calls = 0;
    const result = await attempt(async () => { calls++; return "open"; }, { tries: 3, delayMs: 1, sleep: instant });

    expect(result).toBe("open");
    expect(calls).toBe(1);
  });

  it("tries again for a file the agent has not finished writing", async () => {
    let calls = 0;
    const result = await attempt(async () => {
      calls++;
      if (calls < 2) throw new Error("ENOENT");
      return "open";
    }, { tries: 3, delayMs: 1, sleep: instant });

    expect(result).toBe("open");
    expect(calls).toBe(2);
  });

  /**
   * A file that never appears is an agent that changed its mind, or a path on
   * a machine this window cannot see. Neither is worth a dialog.
   */
  it("gives up quietly rather than throwing into the extension host", async () => {
    let calls = 0;
    const result = await attempt(async () => { calls++; throw new Error("ENOENT"); },
      { tries: 3, delayMs: 1, sleep: instant });

    expect(result).toBeNull();
    expect(calls).toBe(3);
  });

  it("waits between tries", async () => {
    const waits: number[] = [];
    await attempt(async () => { throw new Error("ENOENT"); }, {
      tries: 3, delayMs: 250, sleep: async (ms) => { waits.push(ms); },
    });

    // Two waits for three tries - nothing is waited for after the last one.
    expect(waits).toEqual([250, 250]);
  });
});
