import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import { isStopKey, onStopKey } from "../src/daemon/stop-key.js";

/** Ctrl-C as the terminal hands it over once it has stopped interpreting it. */
const CTRL_C = "\u0003";

/** A terminal, or something pretending to be one. */
class FakeStdin extends EventEmitter {
  isTTY = true;
  raw = false;
  resumed = false;
  encoding = "";
  setRawMode(on: boolean) { this.raw = on; return this; }
  resume() { this.resumed = true; return this; }
  pause() { this.resumed = false; return this; }
  setEncoding(enc: string) { this.encoding = enc; return this; }
}

const stdin = (over: Partial<FakeStdin> = {}) => Object.assign(new FakeStdin(), over) as any;

describe("the key that stops the daemon", () => {
  it("takes q, and Q, and ctrl-c", () => {
    // Raw mode is what reading a key at all costs, and in raw mode the
    // terminal stops turning ctrl-c into a signal. Listening for q without
    // listening for ctrl-c would break the gesture everybody already knows.
    expect(isStopKey("q")).toBe(true);
    expect(isStopKey("Q")).toBe(true);
    expect(isStopKey(CTRL_C)).toBe(true);
  });

  it("leaves every other key alone", () => {
    for (const key of ["a", "Q ", "", "\r", "\u001b", "\u0004"]) expect(isStopKey(key)).toBe(false);
  });

  it("stops on a key press", () => {
    const stop = vi.fn();
    const input = stdin();
    onStopKey(stop, input);

    input.emit("data", "q");
    expect(stop).toHaveBeenCalledOnce();
  });

  it("stops on ctrl-c, which no longer arrives as a signal", () => {
    const stop = vi.fn();
    const input = stdin();
    onStopKey(stop, input);

    input.emit("data", CTRL_C);
    expect(stop).toHaveBeenCalledOnce();
  });

  it("puts the terminal back, so the shell after it still echoes", () => {
    // A process that exits from raw mode leaves the terminal behind it with
    // no echo, which looks exactly like a broken shell to whoever types next.
    const input = stdin();
    const restore = onStopKey(() => {}, input);
    expect(input.raw).toBe(true);

    restore();
    expect(input.raw).toBe(false);
    expect(input.resumed).toBe(false);
  });

  it("does not listen at all when nobody is sitting there", () => {
    // Under a process manager, or with output going to a file, stdin is not
    // a terminal and raw mode throws.
    const input = stdin({ isTTY: false });
    const stop = vi.fn();

    const restore = onStopKey(stop, input);
    input.emit("data", "q");

    expect(input.raw).toBe(false);
    expect(stop).not.toHaveBeenCalled();
    expect(() => restore()).not.toThrow();
  });
});
