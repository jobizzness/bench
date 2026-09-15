/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * A command to a machine whose daemon is not listening - off, asleep, or
 * booted into a network drop it never recovered from - has nobody to answer
 * it. Without a deadline, the result listener waits forever and the phone
 * shows a spinner that never resolves.
 */
const { listeners, setDocMock, deleteDocMock } = vi.hoisted(() => ({
  listeners: new Map<string, (snap: unknown) => void>(),
  setDocMock: vi.fn(async (_ref: { path: string }, _data: unknown) => {}),
  deleteDocMock: vi.fn(async (_ref: { path: string }) => {}),
}));

vi.mock("firebase/app", () => ({ initializeApp: vi.fn(() => ({})) }));
vi.mock("firebase/firestore", () => ({
  getFirestore: vi.fn(() => ({})),
  initializeFirestore: vi.fn(() => ({})),
  persistentLocalCache: vi.fn(() => ({})),
  doc: vi.fn((_db: unknown, path: string) => ({ path })),
  onSnapshot: vi.fn((ref: { path: string }, cb: (s: unknown) => void) => {
    listeners.set(ref.path, cb);
    return () => listeners.delete(ref.path);
  }),
  setDoc: setDocMock,
  deleteDoc: deleteDocMock,
}));

const { sendCommand, COMMAND_TIMEOUT_MS } = await import("../src/client/remote-transport.js");
const { encode } = await import("../src/shared/remote-codec.js");

beforeEach(() => {
  vi.useFakeTimers();
  listeners.clear();
  setDocMock.mockClear();
  deleteDocMock.mockClear();
});
afterEach(() => { vi.useRealTimers(); });

const deleted = () => deleteDocMock.mock.calls.map(([ref]) => ref.path);

describe("sendCommand to a machine that never answers", () => {
  it("rejects once the deadline passes, instead of waiting forever", async () => {
    const pending = sendCommand("u1", "m1", "GET", "/api/settings", undefined);
    const outcome = pending.then(() => "resolved", (error: Error) => error.message);

    await vi.advanceTimersByTimeAsync(COMMAND_TIMEOUT_MS);

    expect(await outcome).toMatch(/did not answer/);
  });

  it("withdraws the command, so a daemon that wakes later does not run what the phone already reported as failed", async () => {
    const pending = sendCommand("u1", "m1", "POST", "/api/sessions/s1/message", { text: "hi" });
    pending.catch(() => {});
    const commandPath = (setDocMock.mock.calls[0][0] as { path: string }).path;

    await vi.advanceTimersByTimeAsync(COMMAND_TIMEOUT_MS);

    expect(deleted()).toContain(commandPath);
    expect(listeners.size).toBe(0);
  });

  it("still resolves normally when the answer arrives in time", async () => {
    const pending = sendCommand("u1", "m1", "GET", "/api/settings", undefined);
    const resultPath = [...listeners.keys()][0];

    listeners.get(resultPath)?.({
      exists: () => true,
      data: () => ({ status: 200, contentType: "application/json", body: encode("{}") }),
    });
    await vi.advanceTimersByTimeAsync(COMMAND_TIMEOUT_MS);

    await expect(pending).resolves.toMatchObject({ status: 200 });
    expect(deleted()).not.toContain((setDocMock.mock.calls[0][0] as { path: string }).path);
  });
});
