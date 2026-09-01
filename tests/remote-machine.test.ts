import { describe, it, expect } from "vitest";
import { firestoreClient, FirestoreRequestFailed } from "../src/daemon/remote/firestore-rest.js";
import { deregisterMachine, heartbeat, registerMachine } from "../src/daemon/remote/machine.js";

interface Call { url: string; method: string; body: any }

function recordingFetch(answer: (call: Call) => { status: number; body: unknown }): { fetchImpl: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const call = { url, method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : null };
    calls.push(call);
    const { status, body } = answer(call);
    return new Response(JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

describe("registering a machine", () => {
  it("writes to /users/{uid}/machines/{machineId}, bearer-authorised with the ID token", async () => {
    const { fetchImpl, calls } = recordingFetch(() => ({ status: 200, body: {} }));
    const client = firestoreClient({ projectId: "bench-cockpit", idToken: () => "the-id-token", fetchImpl });

    await registerMachine(client, "u1", "m1", { name: "laptop", platform: "darwin", version: "0.1.0", lastSeen: 1000 });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain("/projects/bench-cockpit/databases/(default)/documents/users/u1/machines/m1");
    expect(calls[0].method).toBe("PATCH");
    expect(calls[0].body.fields.name).toEqual({ stringValue: "laptop" });
    expect(calls[0].body.fields.lastSeen).toEqual({ integerValue: "1000" });
  });

  it("refuses to write with no ID token, rather than send an unauthenticated request", async () => {
    const client = firestoreClient({ projectId: "bench-cockpit", idToken: () => null });
    await expect(registerMachine(client, "u1", "m1", { name: "x", platform: "x", version: "x", lastSeen: 1 }))
      .rejects.toThrow(FirestoreRequestFailed);
  });

  it("throws when Firestore refuses the write", async () => {
    const { fetchImpl } = recordingFetch(() => ({ status: 403, body: { error: { message: "PERMISSION_DENIED" } } }));
    const client = firestoreClient({ projectId: "bench-cockpit", idToken: () => "id", fetchImpl });
    await expect(registerMachine(client, "u1", "m1", { name: "x", platform: "x", version: "x", lastSeen: 1 }))
      .rejects.toThrow(FirestoreRequestFailed);
  });
});

describe("heartbeat", () => {
  it("advances lastSeen without needing a separate route", async () => {
    const { fetchImpl, calls } = recordingFetch(() => ({ status: 200, body: {} }));
    const client = firestoreClient({ projectId: "bench-cockpit", idToken: () => "id", fetchImpl });

    await heartbeat(client, "u1", "m1", "laptop", "darwin", "0.1.0");

    expect(calls[0].body.fields.lastSeen.integerValue).toBeDefined();
    expect(Number(calls[0].body.fields.lastSeen.integerValue)).toBeGreaterThan(0);
  });
});

describe("deregistering a machine", () => {
  it("deletes the machine document", async () => {
    const { fetchImpl, calls } = recordingFetch(() => ({ status: 200, body: {} }));
    const client = firestoreClient({ projectId: "bench-cockpit", idToken: () => "id", fetchImpl });

    await deregisterMachine(client, "u1", "m1");

    expect(calls[0].method).toBe("DELETE");
    expect(calls[0].url).toContain("users/u1/machines/m1");
  });

  it("treats an already-gone document as success, not a failure to report", async () => {
    const { fetchImpl } = recordingFetch(() => ({ status: 404, body: {} }));
    const client = firestoreClient({ projectId: "bench-cockpit", idToken: () => "id", fetchImpl });
    await expect(deregisterMachine(client, "u1", "m1")).resolves.toBeUndefined();
  });
});

describe("firestoreClient.get", () => {
  it("decodes Firestore's typed fields back into a plain object", async () => {
    const { fetchImpl } = recordingFetch(() => ({
      status: 200,
      body: { fields: { name: { stringValue: "laptop" }, lastSeen: { integerValue: "42" } } },
    }));
    const client = firestoreClient({ projectId: "bench-cockpit", idToken: () => "id", fetchImpl });
    expect(await client.get("users/u1/machines/m1")).toEqual({ name: "laptop", lastSeen: 42 });
  });

  it("returns null for a document that does not exist, not an error", async () => {
    const { fetchImpl } = recordingFetch(() => ({ status: 404, body: {} }));
    const client = firestoreClient({ projectId: "bench-cockpit", idToken: () => "id", fetchImpl });
    expect(await client.get("users/u1/machines/m1")).toBeNull();
  });
});
