import { describe, it, expect } from "vitest";
import { fakeFirestore } from "./helpers/fake-firestore.js";
import { firestoreClient } from "../src/daemon/remote/firestore-rest.js";
import { RemoteBridge, type RemoteBridgeOptions } from "../src/daemon/remote/bridge.js";
import { WriteBudget } from "../src/daemon/remote/write-budget.js";
import { encode, decode } from "../src/shared/remote-codec.js";
import type { RosterRow } from "../src/shared/types.js";

const UID = "u1";
const MACHINE = "m1";

function row(id: string, over: Partial<RosterRow> = {}): RosterRow {
  return {
    id, label: id, role: "specialist" as any, branch: "b", isolated: true, project: "/p",
    model: "opus", status: "awaiting_decision", detail: "ready", latestReportSeq: null,
    answeredReportSeq: null, startedAt: null, tokens: 0, context: null, activity: [],
    spend: null, answeredBy: null, createdBy: null, pendingPrompt: null, broadcast: false,
    ...over,
  };
}

function harness(overrides: Partial<RemoteBridgeOptions> = {}) {
  const backend = fakeFirestore();
  const client = firestoreClient({ projectId: "p", idToken: () => "tok", fetchImpl: backend.fetchImpl });
  let now = 1_000_000;
  const localCalls: Array<{ method: string; path: string; body: unknown }> = [];
  let rows: RosterRow[] = [];
  const localHandlers = new Map<string, () => { status: number; contentType: string; text: string }>();

  const callLocal = async (method: string, path: string, body: unknown) => {
    localCalls.push({ method, path, body });
    const handler = localHandlers.get(`${method} ${path}`);
    if (handler) return handler();
    if (/\/thread$/.test(path)) return { status: 200, contentType: "application/json", text: JSON.stringify([]) };
    if (/\/plan$/.test(path)) return { status: 200, contentType: "application/json", text: JSON.stringify({ steps: [] }) };
    return { status: 404, contentType: "application/json", text: "{}" };
  };

  const bridge = new RemoteBridge({
    client, uid: UID, machineId: MACHINE,
    listBroadcast: () => rows.filter((r) => r.broadcast),
    callLocal,
    now: () => now,
    viewerPollMs: 30_000,
    tickMs: 2_000,
    setIntervalImpl: ((fn: () => void) => ({ fn, unref: () => {} } as any)) as any,
    clearIntervalImpl: (() => {}) as any,
    ...overrides,
  });

  return {
    backend, client, bridge, callLocal, localCalls, localHandlers,
    setRows: (r: RosterRow[]) => { rows = r; },
    advance: (ms: number) => { now += ms; },
    setViewer: async (deviceId: string, watching: string | null) => {
      await client.set(`users/${UID}/machines/${MACHINE}/viewers/${deviceId}`, { at: now, watching: watching ?? "" });
    },
    setCommand: async (id: string, method: string, path: string, body: unknown) => {
      await client.set(`users/${UID}/machines/${MACHINE}/commands/${id}`, {
        method, path, body: body === undefined ? "" : encode(body), at: now,
      });
    },
    getResult: (id: string) => backend.docs.get(`users/${UID}/machines/${MACHINE}/results/${id}`),
  };
}

describe("RemoteBridge with no viewer", () => {
  it("makes zero Firestore writes", async () => {
    const h = harness();
    h.setRows([row("s1", { broadcast: true })]);
    h.bridge.start();
    await Promise.resolve();
    expect(h.backend.writes).toEqual([]);
  });
});

describe("RemoteBridge with a fresh viewer", () => {
  it("writes the roster mirror, broadcast rows only", async () => {
    const h = harness();
    h.setRows([row("s1", { broadcast: true }), row("s2", { broadcast: false })]);
    h.bridge.start();
    await h.setViewer("dev1", null);
    await (h.bridge as any).pollViewers();
    await (h.bridge as any).tick();

    const mirrored = h.backend.docs.get(`users/${UID}/machines/${MACHINE}/mirror/roster`);
    expect(mirrored).toBeDefined();
    const rows = decode<RosterRow[]>(String(mirrored!.payload));
    expect(rows.map((r) => r.id)).toEqual(["s1"]);
  });

  it("does not create any document for a non-broadcast session", async () => {
    const h = harness();
    h.setRows([row("secret", { broadcast: false })]);
    h.bridge.start();
    await h.setViewer("dev1", "secret");
    await (h.bridge as any).pollViewers();
    await (h.bridge as any).tick();

    expect(h.backend.docs.has(`users/${UID}/machines/${MACHINE}/mirror/secret`)).toBe(false);
  });

  it("executes a command against a broadcast session and writes+deletes it", async () => {
    const h = harness();
    h.setRows([row("s1", { broadcast: true })]);
    h.localHandlers.set("POST /api/sessions/s1/message", () => ({ status: 200, contentType: "application/json", text: JSON.stringify({ ok: true }) }));
    h.bridge.start();
    await h.setViewer("dev1", null);
    await h.setCommand("c1", "POST", "/api/sessions/s1/message", { text: "hi" });
    await (h.bridge as any).pollViewers();
    await (h.bridge as any).tick();

    expect(h.localCalls).toContainEqual({ method: "POST", path: "/api/sessions/s1/message", body: { text: "hi" } });
    const result = h.getResult("c1");
    expect(result?.status).toBe(200);
    expect(decode(String(result!.body))).toBe(JSON.stringify({ ok: true }));
    expect(h.backend.docs.has(`users/${UID}/machines/${MACHINE}/commands/c1`)).toBe(false);
  });

  it("refuses a command naming a session that is not broadcast, without calling the local server", async () => {
    const h = harness();
    h.setRows([row("secret", { broadcast: false })]);
    h.bridge.start();
    await h.setViewer("dev1", null);
    await h.setCommand("c1", "POST", "/api/sessions/secret/message", { text: "hi" });
    await (h.bridge as any).pollViewers();
    await (h.bridge as any).tick();

    expect(h.localCalls.some((c) => c.path === "/api/sessions/secret/message")).toBe(false);
    const result = h.getResult("c1");
    expect(result?.status).toBe(403);
    expect(h.backend.docs.has(`users/${UID}/machines/${MACHINE}/commands/c1`)).toBe(false);
  });

  it("allows a machine-global command regardless of any session's broadcast flag", async () => {
    const h = harness();
    h.setRows([row("secret", { broadcast: false })]);
    h.localHandlers.set("GET /api/settings", () => ({ status: 200, contentType: "application/json", text: "{}" }));
    h.bridge.start();
    await h.setViewer("dev1", null);
    await h.setCommand("c1", "GET", "/api/settings", undefined);
    await (h.bridge as any).pollViewers();
    await (h.bridge as any).tick();

    expect(h.localCalls.some((c) => c.path === "/api/settings")).toBe(true);
    expect(h.getResult("c1")?.status).toBe(200);
  });
});

describe("RemoteBridge and broadcast turning off", () => {
  it("deletes that session's mirror on the next tick", async () => {
    const h = harness();
    h.setRows([row("s1", { broadcast: true })]);
    h.bridge.start();
    await h.setViewer("dev1", "s1");
    await (h.bridge as any).pollViewers();
    await (h.bridge as any).tick();
    expect(h.backend.docs.has(`users/${UID}/machines/${MACHINE}/mirror/s1`)).toBe(true);

    h.setRows([row("s1", { broadcast: false })]);
    await (h.bridge as any).tick();
    expect(h.backend.docs.has(`users/${UID}/machines/${MACHINE}/mirror/s1`)).toBe(false);
  });
});

describe("RemoteBridge and a viewer going stale", () => {
  it("deletes the whole mirror", async () => {
    const h = harness();
    h.setRows([row("s1", { broadcast: true })]);
    h.bridge.start();
    await h.setViewer("dev1", "s1");
    await (h.bridge as any).pollViewers();
    await (h.bridge as any).tick();
    expect(h.backend.docs.has(`users/${UID}/machines/${MACHINE}/mirror/roster`)).toBe(true);

    h.advance(4 * 60_000); // past the 3-minute staleness window
    await (h.bridge as any).pollViewers();

    expect(h.backend.docs.has(`users/${UID}/machines/${MACHINE}/mirror/roster`)).toBe(false);
    expect(h.backend.docs.has(`users/${UID}/machines/${MACHINE}/mirror/s1`)).toBe(false);
  });
});

describe("RemoteBridge coalescing", () => {
  it("drives 100 roster changes inside the coalescing window and leaves at most one extra write", async () => {
    const h = harness();
    h.setRows([row("s1", { broadcast: true })]);
    h.bridge.start();
    await h.setViewer("dev1", null);
    await (h.bridge as any).pollViewers();
    await (h.bridge as any).tick(); // the initial snapshot write

    const before = h.backend.writes.length;
    for (let i = 0; i < 100; i++) {
      h.setRows([row("s1", { broadcast: true, detail: `step ${i}` })]);
      await (h.bridge as any).tick();
    }
    const extra = h.backend.writes.length - before;
    expect(extra).toBeLessThanOrEqual(1);
  });

  it("writes again once the coalescing window has passed", async () => {
    const h = harness();
    h.setRows([row("s1", { broadcast: true })]);
    h.bridge.start();
    await h.setViewer("dev1", null);
    await (h.bridge as any).pollViewers();
    await (h.bridge as any).tick();

    const before = h.backend.writes.length;
    h.advance(2_100);
    h.setRows([row("s1", { broadcast: true, detail: "changed" })]);
    await (h.bridge as any).tick();
    expect(h.backend.writes.length).toBe(before + 1);
  });
});

describe("RemoteBridge and the write budget", () => {
  it("shows degraded once the day's writes cross the threshold, reachable by seeding the count", async () => {
    const budget = new WriteBudget({ now: () => 1_000_000 });
    budget.record(15_000);
    const h = harness({ budget } as any);
    h.setRows([row("s1", { broadcast: true })]);
    h.bridge.start();
    await h.setViewer("dev1", null);
    await (h.bridge as any).pollViewers();
    await (h.bridge as any).tick();

    const mirrored = h.backend.docs.get(`users/${UID}/machines/${MACHINE}/mirror/roster`);
    expect(mirrored?.degraded).toBe(1);
  });
});

describe("RemoteBridge.wipe", () => {
  it("empties commands, results, viewers and mirror", async () => {
    const h = harness();
    h.setRows([row("s1", { broadcast: true })]);
    h.bridge.start();
    await h.setViewer("dev1", "s1");
    await h.setCommand("c1", "GET", "/api/settings", undefined);
    await (h.bridge as any).pollViewers();
    await (h.bridge as any).tick();

    await h.bridge.wipe();

    const remaining = [...h.backend.docs.keys()].filter((k) => k.startsWith(`users/${UID}/machines/${MACHINE}/`));
    expect(remaining).toEqual([]);
  });
});
