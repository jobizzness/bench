import { describe, it, expect } from "vitest";
import { fakeFirestore } from "./helpers/fake-firestore.js";
import { firestoreClient } from "../src/daemon/remote/firestore-rest.js";
import { readPresence, presencePath, VIEWER_STALE_MS } from "../src/daemon/remote/presence.js";

const UID = "u1";
const MACHINE = "m1";
const NOW = 1_000_000;

function client(backend: ReturnType<typeof fakeFirestore>) {
  return firestoreClient({ projectId: "p", idToken: () => "tok", fetchImpl: backend.fetchImpl });
}

describe("readPresence", () => {
  it("is inactive with no presence document at all", async () => {
    const backend = fakeFirestore();
    const presence = await readPresence(client(backend), UID, MACHINE, NOW);
    expect(presence).toEqual({ active: false, watching: new Set() });
  });

  it("is active with one fresh viewer, and costs exactly one read", async () => {
    const backend = fakeFirestore();
    backend.docs.set(presencePath(UID, MACHINE), { viewers: { dev1: { at: NOW, watching: "" } } });

    const presence = await readPresence(client(backend), UID, MACHINE, NOW);
    expect(presence.active).toBe(true);
    expect(presence.watching).toEqual(new Set());
    expect(backend.reads).toHaveLength(1);
  });

  it("collects every fresh viewer's watched session, from several devices in the one map", async () => {
    const backend = fakeFirestore();
    backend.docs.set(presencePath(UID, MACHINE), {
      viewers: {
        dev1: { at: NOW, watching: "s1" },
        dev2: { at: NOW, watching: "s2" },
        dev3: { at: NOW, watching: "" }, // watching nothing in particular
      },
    });

    const presence = await readPresence(client(backend), UID, MACHINE, NOW);
    expect(presence.active).toBe(true);
    expect(presence.watching).toEqual(new Set(["s1", "s2"]));
  });

  it("ignores a viewer whose heartbeat is stale", async () => {
    const backend = fakeFirestore();
    backend.docs.set(presencePath(UID, MACHINE), {
      viewers: { dev1: { at: NOW - VIEWER_STALE_MS - 1, watching: "s1" } },
    });

    const presence = await readPresence(client(backend), UID, MACHINE, NOW);
    expect(presence).toEqual({ active: false, watching: new Set() });
  });

  it("is active if at least one of several viewers is fresh, even if others are stale", async () => {
    const backend = fakeFirestore();
    backend.docs.set(presencePath(UID, MACHINE), {
      viewers: {
        stale: { at: NOW - VIEWER_STALE_MS - 1, watching: "s1" },
        fresh: { at: NOW, watching: "s2" },
      },
    });

    const presence = await readPresence(client(backend), UID, MACHINE, NOW);
    expect(presence.active).toBe(true);
    expect(presence.watching).toEqual(new Set(["s2"]));
  });

  it("does not choke on a malformed entry in the map", async () => {
    const backend = fakeFirestore();
    backend.docs.set(presencePath(UID, MACHINE), {
      viewers: { broken: { at: "not-a-number" as any, watching: "s1" } },
    });

    const presence = await readPresence(client(backend), UID, MACHINE, NOW);
    expect(presence).toEqual({ active: false, watching: new Set() });
  });
});
