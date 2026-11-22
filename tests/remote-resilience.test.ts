import { describe, it, expect } from "vitest";
import { fakeFirestore } from "./helpers/fake-firestore.js";
import { firestoreClient } from "../src/daemon/remote/firestore-rest.js";
import { RemoteBridge } from "../src/daemon/remote/bridge.js";
import { runPendingCommands } from "../src/daemon/remote/command-runner.js";
import { WriteBudget } from "../src/daemon/remote/write-budget.js";
import { encode, decode } from "../src/shared/remote-codec.js";
import type { RosterRow } from "../src/shared/types.js";

const UID = "u1";
const MACHINE = "m1";
const BASE = `users/${UID}/machines/${MACHINE}`;

/** A fake Firestore with one extra lever: answer a matching request with an
 * HTTP error instead of letting it through. */
function harness() {
  const backend = fakeFirestore();
  let refuse: ((url: string, method: string) => number | null) = () => null;
  const calls: string[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    calls.push(`${method} ${url}`);
    const status = refuse(url, method);
    if (status !== null) return new Response(JSON.stringify({ error: { status: "REFUSED" } }), { status });
    return (backend.fetchImpl as unknown as typeof fetch)(url as unknown as URL, init);
  }) as unknown as typeof fetch;
  const client = firestoreClient({ projectId: "p", idToken: () => "tok", fetchImpl });
  return {
    backend, client, calls,
    setRefuse: (fn: (url: string, method: string) => number | null) => { refuse = fn; },
  };
}

const rows = [{ id: "s1", broadcast: true }, { id: "s2", broadcast: true }] as unknown as RosterRow[];

describe("a command the daemon cannot run", () => {
  it("answers 502 when the local call throws, instead of leaving the command to be retried forever", async () => {
    const h = harness();
    await h.client.set(`${BASE}/commands/c1`, { method: "GET", path: "/api/roster", body: "", at: 1 });
    const writes = await runPendingCommands(h.client, UID, MACHINE, rows, async () => { throw new Error("socket hang up"); });

    expect(writes).toBe(1);
    const result = h.backend.docs.get(`${BASE}/results/c1`)!;
    expect(result.status).toBe(502);
    expect(decode<string>(String(result.body))).toContain("socket hang up");
    expect(h.backend.docs.has(`${BASE}/commands/c1`)).toBe(false);
  });

  it("answers 400 for a body that will not parse, without calling the local server", async () => {
    const h = harness();
    await h.client.set(`${BASE}/commands/c1`, { method: "POST", path: "/api/roster", body: "{not json", at: 1 });
    let called = false;
    await runPendingCommands(h.client, UID, MACHINE, rows, async () => { called = true; return { status: 200, contentType: "", text: "" }; });

    expect(called).toBe(false);
    expect(h.backend.docs.get(`${BASE}/results/c1`)!.status).toBe(400);
    expect(h.backend.docs.has(`${BASE}/commands/c1`)).toBe(false);
  });

  it("still answers the other commands when one result cannot be written, and reports what it did write", async () => {
    const h = harness();
    await h.client.set(`${BASE}/commands/good`, { method: "GET", path: "/api/roster", body: "", at: 1 });
    await h.client.set(`${BASE}/commands/bad`, { method: "GET", path: "/api/roster", body: "", at: 1 });
    h.setRefuse((url, method) => (method === "PATCH" && url.endsWith("/results/bad") ? 500 : null));

    const ok = async () => ({ status: 200, contentType: "application/json", text: "{}" });
    const error = await runPendingCommands(h.client, UID, MACHINE, rows, ok).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(Error);
    expect((error as { writesBeforeFailure: number }).writesBeforeFailure).toBe(1);
    expect(h.backend.docs.has(`${BASE}/results/good`)).toBe(true);
  });
});

function bridgeHarness() {
  const h = harness();
  let now = 1_000_000;
  const warnings: string[] = [];
  const budget = new WriteBudget({ now: () => now });
  const failDetailFor = new Set<string>();
  const bridge = new RemoteBridge({
    client: h.client, uid: UID, machineId: MACHINE,
    listBroadcast: () => rows,
    callLocal: async (_method, path) => {
      const session = path.split("/")[3]!;
      if (failDetailFor.has(session)) throw new Error(`cannot read ${session}`);
      if (path.endsWith("/thread")) return { status: 200, contentType: "application/json", text: JSON.stringify({ entries: [] }) };
      return { status: 200, contentType: "application/json", text: JSON.stringify({ steps: [] }) };
    },
    now: () => now,
    budget,
    setIntervalImpl: (() => ({ unref() {} })) as never,
    clearIntervalImpl: (() => {}) as never,
    warn: (m) => { warnings.push(m); },
  });
  const setViewer = (watching: string) => {
    h.backend.docs.set(`${BASE}/presence/state`, { viewers: { phone: { at: now, watching } } });
  };
  return {
    ...h, bridge, warnings, budget, failDetailFor, setViewer,
    advance: (ms: number) => { now += ms; },
    supervise: () => (bridge as unknown as { supervise(): Promise<void> }).supervise(),
    tick: () => (bridge as unknown as { tick(): Promise<void> }).tick(),
  };
}

describe("the mirror, one document at a time", () => {
  it("keeps the roster and other sessions current when one session's detail cannot be read", async () => {
    const h = bridgeHarness();
    h.failDetailFor.add("s1");
    // Two devices: one watching s1 (broken), one watching s2.
    h.backend.docs.set(`${BASE}/presence/state`, {
      viewers: { a: { at: 1_000_000, watching: "s1" }, b: { at: 1_000_000, watching: "s2" } },
    });
    await h.supervise();

    expect(h.backend.docs.has(`${BASE}/mirror/roster`)).toBe(true);
    expect(h.backend.docs.has(`${BASE}/mirror/s2`)).toBe(true);
    expect(h.backend.docs.has(`${BASE}/mirror/s1`)).toBe(false);
    expect(h.warnings.join("")).toMatch(/mirror tick failing.*cannot read s1/);
  });

  it("still serves the mirror when the command pass fails", async () => {
    const h = bridgeHarness();
    h.setViewer("s1");
    h.setRefuse((url, method) => (method === "GET" && url.endsWith("/commands") ? 503 : null));
    await h.supervise();

    expect(h.backend.docs.has(`${BASE}/mirror/roster`)).toBe(true);
    expect(h.warnings.join("")).toMatch(/command run failing/);
  });
});

describe("when Firestore's daily quota is spent", () => {
  it("stops calling Firestore, says so once, and probes again after the pause", async () => {
    const h = bridgeHarness();
    h.setViewer("");
    h.setRefuse(() => 429);
    await h.supervise();
    expect(h.warnings.filter((w) => w.includes("daily quota"))).toHaveLength(1);

    // Many supervisor passes and ticks inside the pause: no calls at all.
    h.calls.length = 0;
    for (let i = 0; i < 20; i++) {
      h.advance(30_000);
      await h.supervise();
      await h.tick();
    }
    expect(h.calls).toEqual([]);

    // Quota is back: the next poll after the pause goes through.
    h.setRefuse(() => null);
    h.advance(15 * 60_000);
    h.setViewer("");
    await h.supervise();
    expect(h.backend.docs.has(`${BASE}/mirror/roster`)).toBe(true);
    expect(h.warnings.filter((w) => w.includes("daily quota"))).toHaveLength(1);
  });
});
