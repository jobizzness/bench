import { describe, expect, it } from "vitest";
import {
  RELAY_THREAD_MAX_BYTES, RELAY_THREAD_MAX_ENTRIES, relayThreadText,
} from "../src/daemon/remote/relay-thread.js";
import { runPendingCommands } from "../src/daemon/remote/command-runner.js";
import { MirrorWriter } from "../src/daemon/remote/mirror-writer.js";
import type { FirestoreClient } from "../src/daemon/remote/firestore-rest.js";
import type { ThreadEntry } from "../src/shared/types.js";
import { decode } from "../src/shared/remote-codec.js";

const entry = (seq: number, body = `entry ${seq}`): ThreadEntry => ({
  seq, at: `2026-11-21T00:00:${String(seq % 60).padStart(2, "0")}Z`, kind: seq % 2 ? "reply" : "user", body,
});
const thread = (n: number, body?: (seq: number) => string) =>
  JSON.stringify({ entries: Array.from({ length: n }, (_, i) => entry(i + 1, body?.(i + 1))) });

/** Firestore refuses any field over 1,048,487 bytes. */
const FIRESTORE_FIELD_LIMIT = 1_048_487;

describe("what of a thread crosses Firestore", () => {
  it("leaves a short thread exactly as it is", () => {
    const text = thread(5);
    expect(relayThreadText(text)).toBe(text);
  });

  it("sends only the newest entries of a long thread, and says how many stayed home", () => {
    const out = JSON.parse(relayThreadText(thread(2082)));
    const kept = out.entries.filter((e: ThreadEntry) => e.kind !== "system" || e.seq > 0);
    expect(kept).toHaveLength(RELAY_THREAD_MAX_ENTRIES);
    expect(kept.at(-1).seq).toBe(2082);
    expect(out.omitted).toBe(2082 - RELAY_THREAD_MAX_ENTRIES);
    expect(out.entries[0]).toMatchObject({ kind: "system" });
    expect(out.entries[0].body).toContain(String(2082 - RELAY_THREAD_MAX_ENTRIES));
  });

  it("trims by size too, so a few huge entries cannot break the limit", () => {
    const text = thread(50, () => "x".repeat(100_000));
    const out = relayThreadText(text);
    expect(Buffer.byteLength(out)).toBeLessThanOrEqual(RELAY_THREAD_MAX_BYTES + 1_000);
    expect(JSON.parse(out).entries.at(-1).seq).toBe(50);
  });

  it("always keeps the newest entry, even one bigger than the budget", () => {
    const out = JSON.parse(relayThreadText(thread(3, (s) => (s === 3 ? "y".repeat(RELAY_THREAD_MAX_BYTES * 2) : "small"))));
    expect(out.entries.at(-1).seq).toBe(3);
  });

  it("passes anything that is not a thread through untouched", () => {
    expect(relayThreadText("not json")).toBe("not json");
    expect(relayThreadText('{"error":"no such session"}')).toBe('{"error":"no such session"}');
  });
});

function fakeClient() {
  const writes = new Map<string, Record<string, unknown>>();
  const removed: string[] = [];
  const client = {
    set: async (path: string, data: Record<string, unknown>) => {
      for (const v of Object.values(data)) {
        if (typeof v === "string" && Buffer.byteLength(v) > FIRESTORE_FIELD_LIMIT) {
          throw new Error(`could not write ${path}: 400 longer than ${FIRESTORE_FIELD_LIMIT} bytes`);
        }
      }
      writes.set(path, data);
    },
    remove: async (path: string) => { removed.push(path); },
    list: async () => [],
  } as unknown as FirestoreClient;
  return { client, writes, removed };
}

const row = { id: "s1" } as never;
const bigThread = thread(2082, () => "z".repeat(650));

describe("a phone asking for a long thread", () => {
  it("gets the recent part instead of a write Firestore refuses", async () => {
    const { client, writes, removed } = fakeClient();
    await runPendingCommands(client, "u", "m", [row], async () => (
      { status: 200, contentType: "application/json", text: bigThread }
    ), [{ id: "c1", data: { method: "GET", path: "/api/sessions/s1/thread", body: "" } }]);

    const result = writes.get("users/u/machines/m/results/c1")!;
    expect(result.status).toBe(200);
    const body = JSON.parse(decode<string>(result.body as string));
    expect(body.entries.at(-1).seq).toBe(2082);
    expect(body.omitted).toBeGreaterThan(0);
    expect(removed).toContain("users/u/machines/m/commands/c1");
  });

  it("answers 413 rather than retrying forever when any other answer is too big", async () => {
    const { client, writes, removed } = fakeClient();
    await runPendingCommands(client, "u", "m", [row], async () => (
      { status: 200, contentType: "application/json", text: JSON.stringify({ blob: "q".repeat(1_200_000) }) }
    ), [{ id: "c2", data: { method: "GET", path: "/api/sessions/s1/changes", body: "" } }]);

    expect(writes.get("users/u/machines/m/results/c2")!.status).toBe(413);
    expect(removed).toContain("users/u/machines/m/commands/c2");
  });
});

describe("the mirror of an open session", () => {
  it("carries the recent part of a long thread and fits in one document", async () => {
    const { client, writes } = fakeClient();
    const budget = { cadence: () => ({ timedWritesAllowed: true, coalesceMs: 0 }), record: () => {}, degraded: () => false };
    const mirror = new MirrorWriter(client, "u", "m", budget as never, () => 1_000_000);
    await mirror.sync([row], new Set(["s1"]), async (_m, path) => (
      path.endsWith("/thread")
        ? { status: 200, contentType: "application/json", text: bigThread }
        : { status: 200, contentType: "application/json", text: "null" }
    ));

    const doc = writes.get("users/u/machines/m/mirror/s1")!;
    const detail = decode<{ thread: { entries: ThreadEntry[]; omitted: number } }>(doc.payload as string);
    expect(detail.thread.entries.at(-1)!.seq).toBe(2082);
    expect(detail.thread.omitted).toBeGreaterThan(0);
  });
});
