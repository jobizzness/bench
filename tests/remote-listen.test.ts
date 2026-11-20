import { describe, it, expect } from "vitest";
import { EventEmitter } from "node:events";
import {
  decodeListenResponse, encodeListenRequest, forTests, TargetChangeType,
} from "../src/daemon/remote/listen-proto.js";
import { FirestoreListener, type ListenStream, type RemoteListener } from "../src/daemon/remote/firestore-listen.js";
import { fakeFirestore } from "./helpers/fake-firestore.js";
import { firestoreClient } from "../src/daemon/remote/firestore-rest.js";
import { RemoteBridge } from "../src/daemon/remote/bridge.js";
import { encode } from "../src/shared/remote-codec.js";
import type { RosterRow } from "../src/shared/types.js";

const { Writer } = forTests;
const DB = "projects/p/databases/(default)";
const DOCS = `${DB}/documents/`;

// ------------------------------------------------ building server messages

function value(v: string | number | Record<string, unknown>): InstanceType<typeof Writer> {
  if (typeof v === "string") return new Writer().string(17, v);
  if (typeof v === "number") return new Writer().int(2, v);
  const map = new Writer();
  for (const [k, inner] of Object.entries(v)) map.message(1, new Writer().string(1, k).message(2, value(inner as never)));
  return new Writer().message(6, map);
}

function documentChange(name: string, data: Record<string, unknown>, targetIds: number[], removed: number[] = []): Buffer {
  const doc = new Writer().string(1, DOCS + name);
  for (const [k, v] of Object.entries(data)) doc.message(2, new Writer().string(1, k).message(2, value(v as never)));
  const change = new Writer().message(1, doc);
  for (const id of targetIds) change.int(5, id);
  for (const id of removed) change.int(6, id);
  return new Writer().message(3, change).finish();
}

function documentDelete(name: string, removed: number[]): Buffer {
  const del = new Writer().string(1, DOCS + name);
  for (const id of removed) del.int(6, id);
  return new Writer().message(4, del).finish();
}

function targetChange(type: number, targetIds: number[] = [], resumeToken?: string, cause?: { code: number; message: string }): Buffer {
  const tc = new Writer().int(1, type);
  for (const id of targetIds) tc.int(2, id);
  if (cause) tc.message(3, new Writer().int(1, cause.code).string(2, cause.message));
  if (resumeToken) tc.bytes(4, Buffer.from(resumeToken));
  return new Writer().message(2, tc).finish();
}

function filter(targetId: number, count: number): Buffer {
  return new Writer().message(5, new Writer().int(1, targetId).int(2, count)).finish();
}

// ----------------------------------------------------------- a fake stream

class FakeStream extends EventEmitter {
  written: Buffer[] = [];
  cancelled = false;
  write(m: Buffer) { this.written.push(m); }
  end() {}
  cancel() { this.cancelled = true; }
  push(m: Buffer) { this.emit("data", m); }
}

function harness(token = () => "tok") {
  const streams: FakeStream[] = [];
  const timers: Array<{ fn: () => void; ms: number }> = [];
  const changes: string[] = [];
  const warnings: string[] = [];
  const authHeaders: string[] = [];
  const listener = new FirestoreListener({
    projectId: "p",
    idToken: token,
    targets: [
      { key: "presence", kind: "document", path: "users/u/machines/m/presence/state" },
      { key: "commands", kind: "collection", path: "users/u/machines/m/commands" },
    ],
    onChange: (k) => { changes.push(k); },
    warn: (m) => { warnings.push(m); },
    openStream: (md) => {
      authHeaders.push(String(md.get("authorization")[0]));
      const s = new FakeStream();
      streams.push(s);
      return s as unknown as ListenStream;
    },
    setTimeoutImpl: ((fn: () => void, ms: number) => { timers.push({ fn, ms }); return { unref() {} }; }) as never,
    clearTimeoutImpl: (() => {}) as never,
  });
  const runTimers = () => { for (const t of timers.splice(0)) t.fn(); };
  /** Both targets current, then the global consistent point. */
  const settle = (s: FakeStream, token = "r1") => {
    s.push(targetChange(TargetChangeType.CURRENT, [1, 2], token));
    s.push(targetChange(TargetChangeType.NO_CHANGE, [], token));
  };
  return { listener, streams, timers, changes, warnings, authHeaders, runTimers, settle };
}

describe("listen-proto", () => {
  it("encodes a document target and a collection query with a resume token", () => {
    const doc = encodeListenRequest(DB, { add: { targetId: 1, target: { kind: "document", name: DOCS + "a/b" } } });
    const text = doc.toString("latin1");
    expect(text).toContain(DB);
    expect(text).toContain(DOCS + "a/b");

    const query = encodeListenRequest(DB, {
      add: { targetId: 2, target: { kind: "collection", parent: DOCS + "a/b", collectionId: "commands" }, resumeToken: Buffer.from("RT") },
    });
    const q = query.toString("latin1");
    expect(q).toContain("commands");
    expect(q).toContain("RT");
  });

  it("decodes a document change with nested maps, integers and strings", () => {
    const msg = decodeListenResponse(documentChange("x/y", { s: "hi", n: 1700000000123, m: { a: { at: 5, watching: "" } } }, [1, 2], [3]));
    expect(msg).toEqual({
      kind: "documentChange",
      document: { name: DOCS + "x/y", data: { s: "hi", n: 1700000000123, m: { a: { at: 5, watching: "" } } } },
      targetIds: [1, 2],
      removedTargetIds: [3],
    });
  });

  it("decodes target changes with a cause and a resume token", () => {
    expect(decodeListenResponse(targetChange(TargetChangeType.REMOVE, [2], "tok", { code: 7, message: "denied" }))).toEqual({
      kind: "targetChange", type: TargetChangeType.REMOVE, targetIds: [2],
      cause: { code: 7, message: "denied" }, resumeToken: Buffer.from("tok"),
    });
  });

  it("accepts packed repeated target ids", () => {
    // field 2, wire type 2, length 2, varints 1 and 2
    const packed = Buffer.from([0x08, 0x03, 0x12, 0x02, 0x01, 0x02]);
    const msg = new Writer().bytes(2, packed).finish();
    expect(decodeListenResponse(msg)).toMatchObject({ kind: "targetChange", type: 3, targetIds: [1, 2] });
  });
});

describe("FirestoreListener", () => {
  it("is healthy only once every target is current, and reports each target once", () => {
    const h = harness();
    h.listener.start();
    const s = h.streams[0]!;
    expect(s.written).toHaveLength(2);
    expect(h.authHeaders).toEqual(["Bearer tok"]);

    s.push(documentChange("users/u/machines/m/commands/c1", { method: "GET" }, [2]));
    s.push(targetChange(TargetChangeType.CURRENT, [2], "r"));
    expect(h.listener.healthy()).toBe(false);
    expect(h.changes).toEqual([]);

    h.settle(s);
    expect(h.listener.healthy()).toBe(true);
    expect(h.changes.sort()).toEqual(["commands", "presence"]);
    expect(h.listener.docs("commands")).toEqual([{ id: "c1", data: { method: "GET" } }]);
  });

  it("applies changes and deletes, and only reports the targets that moved", () => {
    const h = harness();
    h.listener.start();
    const s = h.streams[0]!;
    h.settle(s);
    h.changes.length = 0;

    s.push(documentChange("users/u/machines/m/commands/c1", { method: "GET" }, [2]));
    s.push(targetChange(TargetChangeType.NO_CHANGE, [], "r2"));
    expect(h.changes).toEqual(["commands"]);

    s.push(documentDelete("users/u/machines/m/commands/c1", [2]));
    s.push(targetChange(TargetChangeType.NO_CHANGE, [], "r3"));
    expect(h.listener.docs("commands")).toEqual([]);
    expect(h.changes).toEqual(["commands", "commands"]);
  });

  it("reconnects with resume tokens after a server-side close, quietly, and keeps its cache", () => {
    const h = harness();
    h.listener.start();
    const s1 = h.streams[0]!;
    s1.push(documentChange("users/u/machines/m/commands/c1", { method: "GET" }, [2]));
    h.settle(s1, "resume-me");
    // Pretend the stream had been up a while, as a rotated one would.
    (h.listener as unknown as { healthySince: number }).healthySince = Date.now() - 60_000;

    s1.emit("end");
    expect(h.listener.healthy()).toBe(false);
    expect(h.timers[0]!.ms).toBe(0);
    h.runTimers();

    const s2 = h.streams[1]!;
    expect(s2.written.every((m) => m.toString("latin1").includes("resume-me"))).toBe(true);
    expect(h.listener.docs("commands")).toHaveLength(1);
    expect(h.warnings).toEqual([]);
  });

  it("backs off and warns once when the stream keeps failing before it gets healthy", () => {
    const h = harness();
    h.listener.start();
    for (let i = 0; i < 4; i++) {
      h.streams[i]!.emit("error", Object.assign(new Error("unavailable"), { code: 14 }));
      h.runTimers();
    }
    expect(h.warnings).toHaveLength(1);
    expect(h.warnings[0]).toMatch(/polling until it reconnects/);
    expect(h.streams).toHaveLength(5);

    h.settle(h.streams[4]!);
    expect(h.warnings[1]).toMatch(/connected again/);
  });

  it("treats a target the server removes (rules said no) as a failure, with a long floor", () => {
    const h = harness();
    h.listener.start();
    h.streams[0]!.push(targetChange(TargetChangeType.REMOVE, [1], undefined, { code: 7, message: "Missing or insufficient permissions." }));
    expect(h.listener.healthy()).toBe(false);
    expect(h.streams[0]!.cancelled).toBe(true);
    expect(h.timers[0]!.ms).toBeGreaterThanOrEqual(12_000);
    expect(h.warnings[0]).toMatch(/insufficient permissions/);
  });

  it("restarts from scratch for a target whose existence filter disagrees", () => {
    const h = harness();
    h.listener.start();
    const s1 = h.streams[0]!;
    s1.push(documentChange("users/u/machines/m/commands/c1", {}, [2]));
    h.settle(s1, "stale");
    s1.push(filter(2, 0));
    const s2 = h.streams[1]!;
    expect(s2).toBeDefined();
    // The presence target keeps its token; the commands target starts over.
    expect(s2.written[0]!.toString("latin1")).toContain("stale");
    expect(s2.written[1]!.toString("latin1")).not.toContain("stale");
    expect(h.listener.docs("commands")).toEqual([]);
  });

  it("restarts the stream when the ID token rotates, and not otherwise", () => {
    let token = "t1";
    const h = harness(() => token);
    h.listener.start();
    h.settle(h.streams[0]!);
    h.listener.refreshAuth();
    expect(h.streams).toHaveLength(1);
    token = "t2";
    h.listener.refreshAuth();
    expect(h.streams).toHaveLength(2);
    expect(h.authHeaders).toEqual(["Bearer t1", "Bearer t2"]);
  });
});

// ------------------------------------------------------- the bridge on top

class FakeListener implements RemoteListener {
  started = false;
  isHealthy = true;
  presence: Record<string, unknown> | null = null;
  commands: Array<{ id: string; data: Record<string, unknown> }> = [];
  authChecks = 0;
  constructor(readonly onChange: (key: string) => void) {}
  start() { this.started = true; }
  stop() { this.started = false; }
  healthy() { return this.started && this.isHealthy; }
  docs(key: string) {
    if (key === "presence") return this.presence ? [{ id: "state", data: this.presence as never }] : [];
    return this.commands as never;
  }
  refreshAuth() { this.authChecks++; }
}

function bridgeHarness() {
  const backend = fakeFirestore();
  const requests: string[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    requests.push(`${init?.method ?? "GET"} ${url}`);
    return (backend.fetchImpl as unknown as typeof fetch)(url as unknown as URL, init);
  }) as unknown as typeof fetch;
  const client = firestoreClient({ projectId: "p", idToken: () => "tok", fetchImpl });
  let now = 1_000_000;
  let listener: FakeListener | null = null;
  const timers: Array<() => void> = [];
  const localCalls: string[] = [];
  const rows = [{ id: "s1", broadcast: true } as unknown as RosterRow];
  const bridge = new RemoteBridge({
    client, uid: "u", machineId: "m",
    listBroadcast: () => rows,
    callLocal: async (method, path) => {
      localCalls.push(`${method} ${path}`);
      return { status: 200, contentType: "application/json", text: "{}" };
    },
    now: () => now,
    setIntervalImpl: ((fn: () => void) => { timers.push(fn); return { unref() {} }; }) as never,
    clearIntervalImpl: (() => {}) as never,
    listen: (_targets, onChange) => (listener = new FakeListener(onChange)),
    warn: () => {},
  });
  return {
    backend, bridge, requests, localCalls,
    listener: () => listener!,
    supervise: () => (bridge as unknown as { supervise(): Promise<void> }).supervise(),
    tick: () => (bridge as unknown as { tick(): Promise<void> }).tick(),
    advance: (ms: number) => { now += ms; },
    now: () => now,
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("RemoteBridge with a push listener", () => {
  it("runs a pushed command straight away, before any viewer has been seen", async () => {
    const h = bridgeHarness();
    await h.supervise();
    const l = h.listener();
    expect(l.started).toBe(true);
    h.requests.length = 0;

    l.commands = [{ id: "c1", data: { method: "POST", path: "/api/sessions/s1/messages", body: encode({ t: 1 }), at: 1 } }];
    l.onChange("commands");
    await flush(); await flush();

    expect(h.localCalls).toEqual(["POST /api/sessions/s1/messages"]);
    expect(h.backend.docs.has("users/u/machines/m/results/c1")).toBe(true);
    // No list of the commands collection - the listener already had it.
    expect(h.requests.some((r) => r.startsWith("GET ") && r.endsWith("/commands"))).toBe(false);
  });

  it("does not run a command twice while the listener's cache still holds it", async () => {
    const h = bridgeHarness();
    await h.supervise();
    const l = h.listener();
    l.commands = [{ id: "c1", data: { method: "GET", path: "/api/roster", body: "", at: 1 } }];
    l.onChange("commands");
    await flush(); await flush();
    l.onChange("commands");
    l.presence = { viewers: { phone: { at: h.now(), watching: "" } } };
    await h.supervise();
    await h.tick();
    await flush(); await flush();
    expect(h.localCalls.filter((c) => c === "GET /api/roster")).toHaveLength(1);
  });

  it("reads presence from the listener for free, on every pass", async () => {
    const h = bridgeHarness();
    await h.supervise();
    const l = h.listener();
    h.requests.length = 0;
    l.presence = { viewers: { phone: { at: h.now(), watching: "s1" } } };
    l.onChange("presence");
    await flush(); await flush();

    expect(h.backend.docs.has("users/u/machines/m/mirror/roster")).toBe(true);
    expect(h.requests.some((r) => r.startsWith("GET ") && r.includes("/presence/"))).toBe(false);
    expect(l.authChecks).toBeGreaterThan(0);

    // Staleness is time passing, not a change - noticed on the next pass.
    h.advance(4 * 60_000);
    await h.supervise();
    expect(h.backend.docs.has("users/u/machines/m/mirror/roster")).toBe(false);
  });

  it("falls back to polling presence while the listener is not healthy", async () => {
    const h = bridgeHarness();
    await h.supervise();
    h.listener().isHealthy = false;
    h.requests.length = 0;
    h.advance(5_000);
    await h.supervise();
    expect(h.requests.some((r) => r.startsWith("GET ") && r.includes("/presence/state"))).toBe(true);
  });
});
