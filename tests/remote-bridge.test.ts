import { describe, it, expect } from "vitest";
import { fakeFirestore } from "./helpers/fake-firestore.js";
import { firestoreClient } from "../src/daemon/remote/firestore-rest.js";
import { RemoteBridge, type RemoteBridgeOptions } from "../src/daemon/remote/bridge.js";
import { WriteBudget } from "../src/daemon/remote/write-budget.js";
import { encode, decode } from "../src/shared/remote-codec.js";
import type { RosterRow } from "../src/shared/types.js";

const UID = "u1";
const MACHINE = "m1";
const PRESENCE_PATH = `users/${UID}/machines/${MACHINE}/presence/state`;

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
  // The one thing the fake cannot do on its own: not answer at all. A
  // connect timeout to Firestore rejects the `fetch` rather than returning a
  // status, which is a different code path from any error response.
  let unreachable: string | null = null;
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    if (unreachable !== null) throw new TypeError(unreachable);
    return (backend.fetchImpl as unknown as typeof fetch)(url as unknown as URL, init);
  }) as unknown as typeof fetch;
  const client = firestoreClient({ projectId: "p", idToken: () => "tok", fetchImpl });
  const warnings: string[] = [];
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
    viewerPollMs: 5_000,
    idlePollMs: 60_000,
    tickMs: 2_000,
    setIntervalImpl: ((fn: () => void) => ({ fn, unref: () => {} } as any)) as any,
    clearIntervalImpl: (() => {}) as any,
    warn: (message: string) => { warnings.push(message); },
    ...overrides,
  });

  return {
    backend, client, bridge, callLocal, localCalls, localHandlers, warnings,
    /** Cut the wire, the way a connect timeout does. `null` reconnects it. */
    setUnreachable: (reason: string | null) => { unreachable = reason; },
    setRows: (r: RosterRow[]) => { rows = r; },
    advance: (ms: number) => { now += ms; },
    /** Directly poking the fake's document, the same as a device's dotted-path
     * `updateDoc` would land - a merge into whatever is already there, never a
     * whole-document overwrite, so several devices can be set up without one
     * call erasing another's entry. */
    setViewer: (deviceId: string, watching: string | null, at = now) => {
      const existing = (backend.docs.get(PRESENCE_PATH)?.viewers as Record<string, unknown>) ?? {};
      backend.docs.set(PRESENCE_PATH, { viewers: { ...existing, [deviceId]: { at, watching: watching ?? "" } } });
    },
    setCommand: async (id: string, method: string, path: string, body: unknown) => {
      await client.set(`users/${UID}/machines/${MACHINE}/commands/${id}`, {
        method, path, body: body === undefined ? "" : encode(body), at: now,
      });
    },
    getResult: (id: string) => backend.docs.get(`users/${UID}/machines/${MACHINE}/results/${id}`),
    supervise: () => (bridge as any).supervise() as Promise<void>,
    tick: () => (bridge as any).tick() as Promise<void>,
  };
}

describe("RemoteBridge with nothing broadcast", () => {
  it("makes zero Firestore reads or writes, even with a fresh viewer waiting", async () => {
    const h = harness();
    h.setRows([]); // nothing broadcast
    h.setViewer("dev1", null);
    h.bridge.start();
    await h.supervise();

    expect(h.backend.reads).toEqual([]);
    expect(h.backend.writes).toEqual([]);
  });

  it("tears down and stops ticking the moment broadcast goes empty", async () => {
    const h = harness();
    h.setRows([row("s1", { broadcast: true })]);
    h.setViewer("dev1", null);
    h.bridge.start();
    await h.supervise();
    expect(h.backend.docs.has(`users/${UID}/machines/${MACHINE}/mirror/roster`)).toBe(true);

    h.setRows([]); // last broadcast specialist turned off
    await h.supervise();
    expect(h.backend.docs.has(`users/${UID}/machines/${MACHINE}/mirror/roster`)).toBe(false);
  });
});

describe("RemoteBridge with a fresh viewer", () => {
  it("writes the roster mirror, broadcast rows only", async () => {
    const h = harness();
    h.setRows([row("s1", { broadcast: true }), row("s2", { broadcast: false })]);
    h.setViewer("dev1", null);
    h.bridge.start();
    await h.supervise();
    await h.tick();

    const mirrored = h.backend.docs.get(`users/${UID}/machines/${MACHINE}/mirror/roster`);
    expect(mirrored).toBeDefined();
    const rows = decode<RosterRow[]>(String(mirrored!.payload));
    expect(rows.map((r) => r.id)).toEqual(["s1"]);
  });

  it("does not create any document for a non-broadcast session", async () => {
    const h = harness();
    h.setRows([row("secret", { broadcast: false })]);
    h.setViewer("dev1", "secret");
    h.bridge.start();
    await h.supervise();
    await h.tick();

    expect(h.backend.docs.has(`users/${UID}/machines/${MACHINE}/mirror/secret`)).toBe(false);
  });

  it("executes a command against a broadcast session and writes+deletes it", async () => {
    const h = harness();
    h.setRows([row("s1", { broadcast: true })]);
    h.localHandlers.set("POST /api/sessions/s1/message", () => ({ status: 200, contentType: "application/json", text: JSON.stringify({ ok: true }) }));
    h.setViewer("dev1", null);
    h.bridge.start();
    await h.setCommand("c1", "POST", "/api/sessions/s1/message", { text: "hi" });
    await h.supervise();
    await h.tick();

    expect(h.localCalls).toContainEqual({ method: "POST", path: "/api/sessions/s1/message", body: { text: "hi" } });
    const result = h.getResult("c1");
    expect(result?.status).toBe(200);
    expect(decode(String(result!.body))).toBe(JSON.stringify({ ok: true }));
    expect(h.backend.docs.has(`users/${UID}/machines/${MACHINE}/commands/c1`)).toBe(false);
  });

  it("refuses a command naming a session that is not broadcast, without calling the local server", async () => {
    const h = harness();
    // Something else has to be broadcast, or the bridge never polls at all -
    // see "RemoteBridge with nothing broadcast" above.
    h.setRows([row("public", { broadcast: true }), row("secret", { broadcast: false })]);
    h.setViewer("dev1", null);
    h.bridge.start();
    await h.setCommand("c1", "POST", "/api/sessions/secret/message", { text: "hi" });
    await h.supervise();
    await h.tick();

    expect(h.localCalls.some((c) => c.path === "/api/sessions/secret/message")).toBe(false);
    const result = h.getResult("c1");
    expect(result?.status).toBe(403);
    expect(h.backend.docs.has(`users/${UID}/machines/${MACHINE}/commands/c1`)).toBe(false);
  });

  it("allows a machine-global command regardless of any session's broadcast flag", async () => {
    const h = harness();
    h.setRows([row("public", { broadcast: true }), row("secret", { broadcast: false })]);
    h.localHandlers.set("GET /api/settings", () => ({ status: 200, contentType: "application/json", text: "{}" }));
    h.setViewer("dev1", null);
    h.bridge.start();
    await h.setCommand("c1", "GET", "/api/settings", undefined);
    await h.supervise();
    await h.tick();

    expect(h.localCalls.some((c) => c.path === "/api/settings")).toBe(true);
    expect(h.getResult("c1")?.status).toBe(200);
  });
});

describe("RemoteBridge and broadcast turning off", () => {
  it("deletes that session's mirror on the next tick", async () => {
    const h = harness();
    h.setRows([row("s1", { broadcast: true })]);
    h.setViewer("dev1", "s1");
    h.bridge.start();
    await h.supervise();
    await h.tick();
    expect(h.backend.docs.has(`users/${UID}/machines/${MACHINE}/mirror/s1`)).toBe(true);

    h.setRows([row("s1", { broadcast: false })]);
    await h.tick();
    expect(h.backend.docs.has(`users/${UID}/machines/${MACHINE}/mirror/s1`)).toBe(false);
  });
});

describe("RemoteBridge and a viewer going stale", () => {
  it("deletes the whole mirror", async () => {
    const h = harness();
    h.setRows([row("s1", { broadcast: true })]);
    h.setViewer("dev1", "s1");
    h.bridge.start();
    await h.supervise();
    await h.tick();
    expect(h.backend.docs.has(`users/${UID}/machines/${MACHINE}/mirror/roster`)).toBe(true);

    h.advance(4 * 60_000); // past the 3-minute staleness window
    await h.supervise();

    expect(h.backend.docs.has(`users/${UID}/machines/${MACHINE}/mirror/roster`)).toBe(false);
    expect(h.backend.docs.has(`users/${UID}/machines/${MACHINE}/mirror/s1`)).toBe(false);
  });
});

/** Presence-doc reads only - a `supervise()` that finds a fresh viewer also
 * triggers a leading `tick()`, which itself reads `commands` (a second,
 * unrelated read). What "one read per poll" is actually claiming is about
 * the presence document specifically, not the total for that tick. */
const presenceReads = (h: ReturnType<typeof harness>) =>
  h.backend.reads.filter((p) => p === PRESENCE_PATH).length;

describe("RemoteBridge poll cadence", () => {
  it("polls at the watched cadence while a fresh viewer keeps showing up", async () => {
    const h = harness();
    h.setRows([row("s1", { broadcast: true })]);
    h.setViewer("dev1", null);
    h.bridge.start();
    await h.supervise();
    expect(presenceReads(h)).toBe(1);

    h.advance(5_000);
    h.setViewer("dev1", null, 1_000_000 + 5_000);
    await h.supervise();
    expect(presenceReads(h)).toBe(2);
  });

  it("does not poll again before the watched cadence has elapsed", async () => {
    const h = harness();
    h.setRows([row("s1", { broadcast: true })]);
    h.setViewer("dev1", null);
    h.bridge.start();
    await h.supervise();
    expect(presenceReads(h)).toBe(1);

    h.advance(2_000); // under the 5s cadence
    await h.supervise();
    expect(presenceReads(h)).toBe(1);
  });

  it("backs off to the idle cadence after five minutes with no fresh viewer, and speeds back up once one returns", async () => {
    const h = harness();
    h.setRows([row("s1", { broadcast: true })]);
    h.bridge.start();
    await h.supervise(); // no viewer at all - presence.active stays false throughout

    // Five minutes pass with nobody watching. At the 5s cadence that would be
    // 60 polls; at the 60s idle cadence, 5.
    for (let i = 0; i < 20; i++) {
      h.advance(30_000);
      await h.supervise();
    }
    // 6 minutes have passed: ~5s cadence for the first 5 minutes (60 polls),
    // idle cadence for the last minute (1 more) - too many to have stayed on
    // the fast cadence the whole time.
    expect(presenceReads(h)).toBeLessThan(60);

    const readsSoFar = presenceReads(h);
    h.setViewer("dev1", null); // a viewer shows up
    h.advance(60_000);
    await h.supervise(); // idle cadence notices within 60s and reactivates, and mirrors immediately
    expect(h.backend.docs.has(`users/${UID}/machines/${MACHINE}/mirror/roster`)).toBe(true);
    expect(presenceReads(h)).toBe(readsSoFar + 1);

    // Now back on the fast cadence: a poll 5s later should register.
    const afterWake = presenceReads(h);
    h.advance(5_000);
    await h.supervise();
    expect(presenceReads(h)).toBe(afterWake + 1);
  });
});

describe("RemoteBridge presence as one document", () => {
  it("costs one read per poll regardless of how many devices are watching", async () => {
    const h = harness();
    h.setRows([row("s1", { broadcast: true })]);
    h.setViewer("dev1", null);
    h.setViewer("dev2", "s1");
    h.setViewer("dev3", null);
    h.bridge.start();
    await h.supervise();

    expect(presenceReads(h)).toBe(1);
    await h.tick();
    // All three devices are fresh; dev2 watches s1, so it gets a detail mirror.
    expect(h.backend.docs.has(`users/${UID}/machines/${MACHINE}/mirror/s1`)).toBe(true);
  });
});

describe("RemoteBridge coalescing", () => {
  it("drives 100 roster changes inside the coalescing window and leaves at most one extra write", async () => {
    const h = harness();
    h.setRows([row("s1", { broadcast: true })]);
    h.setViewer("dev1", null);
    h.bridge.start();
    await h.supervise();
    await h.tick(); // the initial snapshot write

    const before = h.backend.writes.length;
    for (let i = 0; i < 100; i++) {
      h.setRows([row("s1", { broadcast: true, detail: `step ${i}` })]);
      await h.tick();
    }
    const extra = h.backend.writes.length - before;
    expect(extra).toBeLessThanOrEqual(1);
  });

  it("writes again once the coalescing window has passed", async () => {
    const h = harness();
    h.setRows([row("s1", { broadcast: true })]);
    h.setViewer("dev1", null);
    h.bridge.start();
    await h.supervise();
    await h.tick();

    const before = h.backend.writes.length;
    h.advance(2_100);
    h.setRows([row("s1", { broadcast: true, detail: "changed" })]);
    await h.tick();
    expect(h.backend.writes.length).toBe(before + 1);
  });
});

describe("RemoteBridge and the write budget", () => {
  it("shows degraded once the day's writes cross the threshold, reachable by seeding the count", async () => {
    const budget = new WriteBudget({ now: () => 1_000_000 });
    budget.record(15_000);
    const h = harness({ budget } as any);
    h.setRows([row("s1", { broadcast: true })]);
    h.setViewer("dev1", null);
    h.bridge.start();
    await h.supervise();
    await h.tick();

    const mirrored = h.backend.docs.get(`users/${UID}/machines/${MACHINE}/mirror/roster`);
    expect(mirrored?.degraded).toBe(1);
  });
});

describe("RemoteBridge when Firestore is unreachable", () => {
  /** The crash in #59: the presence read rejected, nothing caught it, and
   * Node 22 turned the unhandled rejection into process exit - so ten seconds
   * of no network took down every specialist on the bench. */
  it("does not reject when the presence read fails", async () => {
    const h = harness();
    h.setRows([row("s1", { broadcast: true })]);
    h.setViewer("dev1", null);
    h.bridge.start();
    h.setUnreachable("fetch failed");

    await expect(h.supervise()).resolves.toBeUndefined();
  });

  it("does not reject when a tick's command run or mirror write fails", async () => {
    const h = harness();
    h.setRows([row("s1", { broadcast: true })]);
    h.setViewer("dev1", "s1");
    h.bridge.start();
    await h.supervise();

    h.setUnreachable("fetch failed");
    await expect(h.tick()).resolves.toBeUndefined();
  });

  /** The fire-and-forget path is the one that actually killed the daemon:
   * `setInterval` throws the return value away, so a rejection there has
   * nowhere to go but the process. */
  it("leaves no unhandled rejection behind when the timer fires", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
    process.on("unhandledRejection", onUnhandled);
    try {
      const h = harness();
      h.setRows([row("s1", { broadcast: true })]);
      h.setViewer("dev1", "s1");
      h.bridge.start();
      h.setUnreachable("fetch failed");

      // Exactly what setInterval does with it: call it, discard the result.
      (h.bridge as any).supervisorTimer.fn();
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("recovers on the next poll once the network comes back", async () => {
    const h = harness();
    h.setRows([row("s1", { broadcast: true })]);
    h.setViewer("dev1", "s1");
    h.bridge.start();

    h.setUnreachable("fetch failed");
    await h.supervise();
    expect(h.backend.docs.has(`users/${UID}/machines/${MACHINE}/mirror/roster`)).toBe(false);

    h.setUnreachable(null);
    h.advance(5_000);
    await h.supervise();
    await h.tick();
    expect(h.backend.docs.has(`users/${UID}/machines/${MACHINE}/mirror/roster`)).toBe(true);
  });

  it("says so once and says when it comes back, not once every poll", async () => {
    const h = harness();
    h.setRows([row("s1", { broadcast: true })]);
    h.setViewer("dev1", "s1");
    h.bridge.start();

    h.setUnreachable("fetch failed");
    for (let i = 0; i < 5; i += 1) {
      h.advance(5_000);
      await h.supervise();
    }
    expect(h.warnings).toHaveLength(1);
    expect(h.warnings[0]).toContain("fetch failed");
    expect(h.warnings[0]).toContain("presence poll");

    h.setUnreachable(null);
    h.advance(5_000);
    await h.supervise();
    expect(h.warnings).toHaveLength(2);
    expect(h.warnings[1]).toMatch(/succeeded again/);
  });

  /** Teardown is a network call too. If the mirror could not be emptied, the
   * bridge has to still believe it is active, or the stale mirror is left in
   * Firestore for a phone to read as a live roster. */
  it("retries the teardown when the mirror could not be emptied", async () => {
    const h = harness();
    h.setRows([row("s1", { broadcast: true })]);
    h.setViewer("dev1", "s1");
    h.bridge.start();
    await h.supervise();
    expect(h.backend.docs.has(`users/${UID}/machines/${MACHINE}/mirror/roster`)).toBe(true);

    h.setRows([]); // broadcast turned off
    h.setUnreachable("fetch failed");
    await h.supervise();
    expect(h.backend.docs.has(`users/${UID}/machines/${MACHINE}/mirror/roster`)).toBe(true);

    h.setUnreachable(null);
    await h.supervise();
    expect(h.backend.docs.has(`users/${UID}/machines/${MACHINE}/mirror/roster`)).toBe(false);
  });
});

describe("RemoteBridge.wipe", () => {
  it("empties commands, results, presence and mirror", async () => {
    const h = harness();
    h.setRows([row("s1", { broadcast: true })]);
    h.setViewer("dev1", "s1");
    h.bridge.start();
    await h.setCommand("c1", "GET", "/api/settings", undefined);
    await h.supervise();
    await h.tick();

    await h.bridge.wipe();

    const remaining = [...h.backend.docs.keys()].filter((k) => k.startsWith(`users/${UID}/machines/${MACHINE}/`));
    expect(remaining).toEqual([]);
  });
});
