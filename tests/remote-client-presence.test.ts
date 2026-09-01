import { describe, it, expect, vi, beforeEach } from "vitest";

const { updateDocMock, setDocMock, deleteFieldMock } = vi.hoisted(() => ({
  updateDocMock: vi.fn(),
  setDocMock: vi.fn(async () => {}),
  deleteFieldMock: vi.fn(() => "DELETE_FIELD_SENTINEL"),
}));

vi.mock("firebase/firestore", () => ({
  doc: vi.fn((_db: unknown, path: string) => ({ path })),
  updateDoc: updateDocMock,
  setDoc: setDocMock,
  deleteField: deleteFieldMock,
}));

const { heartbeat, stopWatching } = await import("../src/client/remote-presence.js");

const DB = {} as any;
const UID = "u1";
const MACHINE = "m1";

beforeEach(() => {
  updateDocMock.mockReset();
  setDocMock.mockReset();
});

describe("heartbeat", () => {
  it("updates only this device's leaf, with a dotted field path", async () => {
    updateDocMock.mockResolvedValue(undefined);
    await heartbeat(DB, UID, MACHINE, "dev1", "s1");

    expect(updateDocMock).toHaveBeenCalledWith(
      { path: `users/${UID}/machines/${MACHINE}/presence/state` },
      "viewers.dev1",
      expect.objectContaining({ watching: "s1" }),
    );
    expect(setDocMock).not.toHaveBeenCalled();
  });

  it("encodes 'watching nothing' as an empty string, not null", async () => {
    updateDocMock.mockResolvedValue(undefined);
    await heartbeat(DB, UID, MACHINE, "dev1", null);

    const [, , entry] = updateDocMock.mock.calls[0];
    expect(entry.watching).toBe("");
  });

  it("falls back to creating the document when there is nothing to update yet", async () => {
    updateDocMock.mockRejectedValue(new Error("no document to update"));
    await heartbeat(DB, UID, MACHINE, "dev1", "s1");

    expect(setDocMock).toHaveBeenCalledWith(
      { path: `users/${UID}/machines/${MACHINE}/presence/state` },
      { viewers: { dev1: expect.objectContaining({ watching: "s1" }) } },
    );
  });
});

describe("stopWatching", () => {
  it("removes only this device's entry, via the delete-field sentinel", async () => {
    updateDocMock.mockResolvedValue(undefined);
    await stopWatching(DB, UID, MACHINE, "dev1");

    expect(deleteFieldMock).toHaveBeenCalled();
    expect(updateDocMock).toHaveBeenCalledWith(
      { path: `users/${UID}/machines/${MACHINE}/presence/state` },
      "viewers.dev1",
      "DELETE_FIELD_SENTINEL",
    );
  });

  it("does not throw when there is nothing to remove", async () => {
    updateDocMock.mockRejectedValue(new Error("not-found"));
    await expect(stopWatching(DB, UID, MACHINE, "dev1")).resolves.toBeUndefined();
  });
});
