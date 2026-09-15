import { describe, it, expect, vi } from "vitest";
import { KeySync } from "../src/daemon/key-sync.js";
import { firestoreClient, type FirestoreClient } from "../src/daemon/remote/firestore-rest.js";
import type { ManagedKey } from "../src/daemon/anthropic-key.js";
import type { Usage } from "../src/daemon/usage.js";
import { RECHECK_AFTER } from "../src/daemon/managed-keys.js";
import { fakeFirestore } from "./helpers/fake-firestore.js";

/**
 * The daemon keeping the profile's Anthropic keys for itself: what lands in
 * Firestore while no cockpit is open, and what gets written back. Firestore
 * is the `fakeFirestore` fetch stub; the registry records rather than runs.
 */

const COLLECTION = "users/u1/anthropicCredentials";

function seedDoc(store: ReturnType<typeof fakeFirestore>, id: string, over: Record<string, string | number> = {}) {
  store.docs.set(`${COLLECTION}/${id}`, {
    key: `sk-ant-api03-${id}23456789`,
    label: `Key ${id}`,
    hint: `…${id}789`,
    status: "unchecked",
    checkedAt: 0,
    createdAt: 1,
    ...over,
  });
}

function fakeRegistry() {
  let held: ManagedKey[] = [];
  const applied: ManagedKey[][] = [];
  return {
    applied,
    held: () => held,
    setManagedApiKeys(keys: ManagedKey[]) { held = keys; applied.push(keys); },
    managedApiKeyStates() {
      return held.map(({ key: _key, ...rest }) => ({ ...rest, active: rest.id === held[0]?.id }));
    },
    refreshManagedUsage: vi.fn(async () => {}),
  };
}

function rig(over: {
  check?: (key: string) => Promise<"ok" | "refused" | "unreachable">;
  usageOf?: (key: string) => Promise<Usage>;
  now?: () => number;
  log?: (line: string) => void;
  store?: ReturnType<typeof fakeFirestore>;
} = {}) {
  const store = over.store ?? fakeFirestore();
  const client: FirestoreClient = firestoreClient({
    projectId: "p", idToken: () => "tok", fetchImpl: store.fetchImpl,
  });
  const registry = fakeRegistry();
  const check = vi.fn(over.check ?? (async () => "ok" as const));
  const usageOf = vi.fn(over.usageOf ?? (async (): Promise<Usage> => ({ available: false, reason: "none" })));
  const sync = new KeySync({
    registry,
    check,
    usageOf,
    now: over.now,
    log: over.log,
    // The tests drive `tick()` by hand; the interval would only leak.
    setIntervalImpl: (() => 0) as unknown as typeof setInterval,
    clearIntervalImpl: (() => {}) as unknown as typeof clearInterval,
  });
  return { store, client, registry, check, usageOf, sync };
}

describe("the daemon syncing the profile's keys itself", () => {
  it("checks new documents, loads them, and writes the verdicts back", async () => {
    const resetsAt = new Date(Date.now() + 3_600_000).toISOString();
    const { store, client, registry, check, sync } = rig({
      usageOf: async (key): Promise<Usage> => key.includes("oat")
        ? { available: true, windows: [{ key: "five_hour", label: "5-hour", percent: 100, resetsAt }] }
        : { available: false, reason: "none" },
    });
    seedDoc(store, "a", { key: "sk-ant-oat01-aaaaaaaaaaaa" });
    seedDoc(store, "b");

    sync.start(client, "u1");
    await sync.tick();

    // The OAuth key's full window makes it exhausted with its reset time;
    // the console key is simply available.
    expect(check).toHaveBeenCalledTimes(2);
    const loaded = registry.applied.at(-1)!;
    expect(loaded).toHaveLength(2);
    expect(loaded.find((k) => k.id === "a")?.status).toBe("exhausted");
    expect(loaded.find((k) => k.id === "b")?.status).toBe("available");

    const writtenA = store.docs.get(`${COLLECTION}/a`)!;
    expect(writtenA.status).toBe("exhausted");
    expect(writtenA.resetsAt).toBe(resetsAt);
    expect(Number(writtenA.checkedAt)).toBeGreaterThan(0);

    // A second pass over unchanged documents writes nothing back.
    const writes = [...store.writes];
    await sync.tick();
    expect(store.writes).toEqual(writes);
  });

  it("leaves a recently checked key alone, but picks up a renamed label", async () => {
    const { store, client, registry, check, sync } = rig();
    seedDoc(store, "a");

    sync.start(client, "u1");
    await sync.tick();
    expect(check).toHaveBeenCalledTimes(1);

    store.docs.get(`${COLLECTION}/a`)!.label = "Renamed";
    await sync.tick();

    expect(check).toHaveBeenCalledTimes(1);
    expect(registry.applied.at(-1)![0].label).toBe("Renamed");
  });

  it("re-checks a key whose verdict has gone stale, and cools an exhausted one until its reset", async () => {
    let t = Date.now();
    const resetsAt = new Date(t + 3_600_000).toISOString();
    const { store, client, check, sync } = rig({
      now: () => t,
      usageOf: async (key): Promise<Usage> => key.includes("oat")
        ? { available: true, windows: [{ key: "five_hour", label: "5-hour", percent: 100, resetsAt }] }
        : { available: false, reason: "none" },
    });
    seedDoc(store, "a", { key: "sk-ant-oat01-aaaaaaaaaaaa" });
    seedDoc(store, "b");

    sync.start(client, "u1");
    await sync.tick();
    expect(check).toHaveBeenCalledTimes(2);

    t += RECHECK_AFTER + 1;
    await sync.tick();

    // b was asked about again; a's window has not turned over, so asking it
    // would be the rate-limit the cooldown exists to avoid.
    expect(check).toHaveBeenCalledTimes(3);
    expect(check).toHaveBeenLastCalledWith(expect.stringContaining("b234"));
    expect(store.docs.get(`${COLLECTION}/a`)!.resetsAt).toBe(resetsAt);
  });

  it("drops a key the profile no longer lists", async () => {
    const { store, client, registry, sync } = rig();
    seedDoc(store, "a");
    seedDoc(store, "b");

    sync.start(client, "u1");
    await sync.tick();
    store.docs.delete(`${COLLECTION}/b`);
    await sync.tick();

    expect(registry.applied.at(-1)!.map((k) => k.id)).toEqual(["a"]);
  });

  it("logs a failed pass once and keeps ticking", async () => {
    const store = fakeFirestore();
    const lines: string[] = [];
    let down = true;
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      if (down && (init?.method ?? "GET") === "GET" && String(url).includes("anthropicCredentials")) {
        return new Response("nope", { status: 500 });
      }
      return (store.fetchImpl as unknown as (u: string, i?: RequestInit) => Promise<Response>)(url, init);
    }) as unknown as typeof fetch;

    const client = firestoreClient({ projectId: "p", idToken: () => "tok", fetchImpl });
    const registry = fakeRegistry();
    seedDoc(store, "a");
    const sync = new KeySync({
      registry,
      check: vi.fn(async () => "ok" as const),
      usageOf: vi.fn(async (): Promise<Usage> => ({ available: false, reason: "none" })),
      log: (line) => lines.push(line),
      setIntervalImpl: (() => 0) as unknown as typeof setInterval,
      clearIntervalImpl: (() => {}) as unknown as typeof clearInterval,
    });

    sync.start(client, "u1");
    await sync.tick();
    await sync.tick();

    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^bench: key sync:/);

    down = false;
    await sync.tick();
    expect(registry.applied.at(-1)!.map((k) => k.id)).toEqual(["a"]);
  });

  it("coalesces overlapping ticks onto the one in flight", async () => {
    let release: (value: "ok") => void = () => {};
    const { store, client, check, sync } = rig({
      check: () => new Promise<"ok">((resolve) => { release = resolve; }),
    });
    seedDoc(store, "a");

    sync.start(client, "u1");
    const a = sync.tick();
    const b = sync.tick();
    await vi.waitFor(() => expect(check).toHaveBeenCalledTimes(1));
    release("ok");
    await Promise.all([a, b]);
    expect(check).toHaveBeenCalledTimes(1);
  });
});
