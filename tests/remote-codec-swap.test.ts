import { describe, it, expect, vi } from "vitest";

/**
 * "Everything written to a command, result or mirror document passes through
 * a single encode function, and everything read through its inverse" - the
 * design's whole reason for the seam is that swapping it (for #48's
 * encryption) is a change to `remote-codec.ts` alone. Proven here by
 * replacing it with something that is deliberately *not* identity - a
 * reversible transform that would corrupt every payload if any code read or
 * wrote around the seam instead of through it - and confirming a full
 * command round trip through `RemoteBridge` still works.
 */
const rot13 = (s: string) => s.replace(/[a-zA-Z]/g, (c) => {
  const base = c <= "Z" ? 65 : 97;
  return String.fromCharCode(((c.charCodeAt(0) - base + 13) % 26) + base);
});

vi.mock("../src/shared/remote-codec.js", () => ({
  encode: (value: unknown) => rot13(JSON.stringify(value) ?? "null"),
  decode: (text: string) => JSON.parse(rot13(text)),
}));

const { fakeFirestore } = await import("./helpers/fake-firestore.js");
const { firestoreClient } = await import("../src/daemon/remote/firestore-rest.js");
const { RemoteBridge } = await import("../src/daemon/remote/bridge.js");
const { decode } = await import("../src/shared/remote-codec.js");
const rowsType = await import("../src/shared/types.js");
type RosterRow = InstanceType<never> & rowsType.RosterRow;

function row(id: string): RosterRow {
  return {
    id, label: id, role: "specialist" as any, branch: "b", isolated: true, project: "/p",
    model: "opus", status: "awaiting_decision", detail: "ready", latestReportSeq: null,
    answeredReportSeq: null, startedAt: null, tokens: 0, context: null, activity: [],
    spend: null, answeredBy: null, createdBy: null, pendingPrompt: null, broadcast: true,
  } as RosterRow;
}

describe("the encode/decode seam, with a non-identity codec swapped in", () => {
  it("still round-trips a full command through the bridge", async () => {
    const backend = fakeFirestore();
    const client = firestoreClient({ projectId: "p", idToken: () => "tok", fetchImpl: backend.fetchImpl });
    const uid = "u1";
    const machineId = "m1";
    let now = 1_000_000;

    const bridge = new RemoteBridge({
      client, uid, machineId,
      listBroadcast: () => [row("s1")],
      callLocal: async () => ({ status: 200, contentType: "application/json", text: JSON.stringify({ hello: "world" }) }),
      now: () => now,
      setIntervalImpl: (() => ({ unref: () => {} })) as any,
      clearIntervalImpl: (() => {}) as any,
    });

    backend.docs.set(`users/${uid}/machines/${machineId}/presence/state`, {
      viewers: { dev1: { at: now, watching: "" } },
    });
    await client.set(`users/${uid}/machines/${machineId}/commands/c1`, {
      method: "GET", path: "/api/sessions/s1/thread", body: "", at: now,
    });

    bridge.start();
    await (bridge as any).supervise();
    await (bridge as any).tick();

    const result = backend.docs.get(`users/${uid}/machines/${machineId}/results/c1`);
    expect(result).toBeDefined();
    // Not what plain identity encoding would have written - proof the ROT13
    // codec, not identity, is what actually wrote this field.
    expect(String(result!.body)).not.toBe(JSON.stringify(JSON.stringify({ hello: "world" })));
    expect(decode(String(result!.body))).toBe(JSON.stringify({ hello: "world" }));

    const mirrored = backend.docs.get(`users/${uid}/machines/${machineId}/mirror/roster`);
    expect(mirrored).toBeDefined();
    const rows = decode<RosterRow[]>(String(mirrored!.payload));
    expect(rows.map((r) => r.id)).toEqual(["s1"]);
    expect(String(mirrored!.payload)).not.toContain('"id":"s1"'); // rotated, not plain JSON
  });
});
