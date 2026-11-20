import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { FirestoreListener } from "../src/daemon/remote/firestore-listen.js";
import { firestoreClient } from "../src/daemon/remote/firestore-rest.js";
import { RemoteBridge } from "../src/daemon/remote/bridge.js";
import { encode, decode } from "../src/shared/remote-codec.js";
import type { RosterRow } from "../src/shared/types.js";

/**
 * The listener against the real Firestore emulator - real `Listen` bytes,
 * real `firestore.rules`. Gated like `firestore-rules.test.ts`: `pnpm test`
 * needs neither Java nor the emulator. Run it with the emulator up:
 *
 *   firebase emulators:exec --only firestore --project demo-bench \
 *     "BENCH_LISTEN_TEST=1 vitest run tests/firestore-listen.emulator.test.ts"
 *
 * What this cannot prove is production accepting a Firebase ID token on the
 * gRPC endpoint - the emulator takes an unsigned token. `scripts/listen-check.mjs`
 * is the one-shot check for that, run by hand with a real sign-in.
 */
const run = process.env.BENCH_LISTEN_TEST === "1" ? describe : describe.skip;

const PROJECT = "demo-bench";
const HOST = process.env.FIRESTORE_EMULATOR_HOST ?? "127.0.0.1:8080";
const BASE = `http://${HOST}`;

/** What the emulator accepts in place of a signed Firebase ID token. */
function mockToken(uid: string): string {
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  return `${b64({ alg: "none", typ: "JWT" })}.${b64({
    iss: `https://securetoken.google.com/${PROJECT}`, aud: PROJECT, sub: uid, user_id: uid,
    iat: now, exp: now + 3600, auth_time: now, firebase: { sign_in_provider: "custom", identities: {} },
  })}.`;
}

/** Nested maps are only ever written by the browser SDK in production;
 * this is the same document shape, written over REST as the rules' owner. */
async function writeRaw(path: string, fields: object): Promise<void> {
  const res = await fetch(`${BASE}/v1/projects/${PROJECT}/databases/(default)/documents/${path}`, {
    method: "PATCH",
    headers: { "content-type": "application/json", authorization: "Bearer owner" },
    body: JSON.stringify({ fields }),
  });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
}

async function clearAll(): Promise<void> {
  await fetch(`${BASE}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: "DELETE" });
}

function presenceFields(viewers: Record<string, { at: number; watching: string }>) {
  const map: Record<string, unknown> = {};
  for (const [id, v] of Object.entries(viewers)) {
    map[id] = { mapValue: { fields: { at: { integerValue: String(v.at) }, watching: { stringValue: v.watching } } } };
  }
  return { viewers: { mapValue: { fields: map } } };
}

async function until(check: () => boolean, ms = 5_000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 25));
  }
}

const listeners: FirestoreListener[] = [];
const bridges: RemoteBridge[] = [];

function listen(uid: string, machine: string, token = () => mockToken(uid)) {
  const changes: string[] = [];
  const warnings: string[] = [];
  const base = `users/${uid}/machines/${machine}`;
  const listener = new FirestoreListener({
    projectId: PROJECT,
    idToken: token,
    endpoint: HOST,
    insecure: true,
    targets: [
      { key: "presence", kind: "document", path: `${base}/presence/state` },
      { key: "commands", kind: "collection", path: `${base}/commands` },
    ],
    onChange: (key) => { changes.push(key); },
    warn: (m) => { warnings.push(m); },
  });
  listeners.push(listener);
  listener.start();
  return { listener, changes, warnings, base };
}

run("FirestoreListener against the emulator", () => {
  beforeAll(async () => { await clearAll(); });
  afterEach(() => {
    for (const l of listeners.splice(0)) l.stop();
    for (const b of bridges.splice(0)) b.stop();
  });

  it("becomes healthy on empty targets", async () => {
    const { listener } = listen("u1", "empty");
    await until(() => listener.healthy());
    expect(listener.docs("presence")).toEqual([]);
    expect(listener.docs("commands")).toEqual([]);
  });

  it("pushes the presence document, nested viewers map included", async () => {
    const { listener, changes, base } = listen("u1", "m-presence");
    await until(() => listener.healthy());
    changes.length = 0;

    await writeRaw(`${base}/presence/state`, presenceFields({ phone: { at: 1234567890123, watching: "s1" } }));
    await until(() => changes.includes("presence"));

    expect(listener.docs("presence")).toEqual([
      { id: "state", data: { viewers: { phone: { at: 1234567890123, watching: "s1" } } } },
    ]);
  });

  it("pushes commands as they are added and forgets them as they are deleted", async () => {
    const uid = "u1";
    const { listener, changes, base } = listen(uid, "m-commands");
    await until(() => listener.healthy());
    const rest = firestoreClient({ projectId: PROJECT, idToken: () => mockToken(uid), baseUrl: BASE });

    await rest.set(`${base}/commands/c1`, { method: "POST", path: "/api/x", body: encode({ a: 1 }), at: 5 });
    await rest.set(`${base}/commands/c2`, { method: "GET", path: "/api/y", body: "", at: 6 });
    await until(() => listener.docs("commands").length === 2);
    expect(changes).toContain("commands");
    const c1 = listener.docs("commands").find((d) => d.id === "c1")!;
    expect(c1.data).toEqual({ method: "POST", path: "/api/x", body: encode({ a: 1 }), at: 5 });

    await rest.remove(`${base}/commands/c1`);
    await until(() => listener.docs("commands").length === 1);
    expect(listener.docs("commands")[0]!.id).toBe("c2");
  });

  it("is refused by the rules for another uid's machine, and says so once", async () => {
    const { listener, warnings } = listen("u1", "m-x", () => mockToken("stranger"));
    await until(() => warnings.length > 0);
    expect(listener.healthy()).toBe(false);
    expect(warnings[0]).toMatch(/listener unavailable/);
    expect(warnings).toHaveLength(1);
  });

  it("survives a token rotation: reconnects, keeps its cache, and keeps receiving", async () => {
    const uid = "u1";
    let token = mockToken(uid);
    const { listener, base } = listen(uid, "m-rotate", () => token);
    const rest = firestoreClient({ projectId: PROJECT, idToken: () => mockToken(uid), baseUrl: BASE });
    await rest.set(`${base}/commands/before`, { method: "GET", path: "/a", body: "", at: 1 });
    await until(() => listener.healthy() && listener.docs("commands").length === 1);

    await new Promise((r) => setTimeout(r, 1100)); // a different iat makes a different token
    token = mockToken(uid);
    listener.refreshAuth();
    expect(listener.healthy()).toBe(false);
    await until(() => listener.healthy());
    expect(listener.docs("commands").map((d) => d.id)).toEqual(["before"]);

    await rest.set(`${base}/commands/after`, { method: "GET", path: "/b", body: "", at: 2 });
    await until(() => listener.docs("commands").length === 2);
  });
});

run("RemoteBridge over the listener, end to end against the emulator", () => {
  it("answers a command in well under a second, without ever listing the collection", async () => {
    const uid = "u2";
    const machine = "m-e2e";
    const base = `users/${uid}/machines/${machine}`;
    const urls: string[] = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      urls.push(`${init?.method ?? "GET"} ${url}`);
      return fetch(url, init);
    }) as unknown as typeof fetch;
    const client = firestoreClient({ projectId: PROJECT, idToken: () => mockToken(uid), baseUrl: BASE, fetchImpl });
    const phone = firestoreClient({ projectId: PROJECT, idToken: () => mockToken(uid), baseUrl: BASE });
    const row = { id: "s1", broadcast: true } as unknown as RosterRow;

    const bridge = new RemoteBridge({
      client, uid, machineId: machine,
      listBroadcast: () => [row],
      callLocal: async (method, path) => ({ status: 200, contentType: "application/json", text: JSON.stringify({ method, path }) }),
      viewerPollMs: 200,
      tickMs: 200,
      listen: (targets, onChange) => {
        const l = new FirestoreListener({ projectId: PROJECT, idToken: () => mockToken(uid), endpoint: HOST, insecure: true, targets, onChange });
        listeners.push(l);
        return l;
      },
      warn: () => {},
    });
    bridges.push(bridge);
    bridge.start();
    await new Promise((r) => setTimeout(r, 1500)); // let the stream come up
    urls.length = 0;

    const sentAt = Date.now();
    await phone.set(`${base}/commands/k1`, { method: "POST", path: "/api/sessions/s1/messages", body: encode({ text: "hi" }), at: sentAt });
    let result: Awaited<ReturnType<typeof phone.get>> = null;
    const start = Date.now();
    while (result === null && Date.now() - start < 5_000) {
      result = await phone.get(`${base}/results/k1`);
      if (result === null) await new Promise((r) => setTimeout(r, 20));
    }
    const elapsed = Date.now() - sentAt;
    if (process.env.BENCH_LISTEN_VERBOSE) console.log(`command round trip: ${elapsed}ms`);

    expect(result).not.toBeNull();
    expect(decode(String(result!.body))).toBe(JSON.stringify({ method: "POST", path: "/api/sessions/s1/messages" }));
    expect(elapsed).toBeLessThan(1_000);
    // The whole point: no `list` of commands, and no presence reads, once
    // the stream is up.
    expect(urls.filter((u) => u.startsWith("GET ") && u.endsWith("/commands"))).toEqual([]);
    expect(urls.filter((u) => u.startsWith("GET ") && u.includes("/presence/"))).toEqual([]);
    expect(await phone.get(`${base}/commands/k1`)).toBeNull();
    // Delivered exactly once, even though the tick kept sweeping the cache.
    await new Promise((r) => setTimeout(r, 800));
    expect(urls.filter((u) => u.startsWith("PATCH ") && u.includes("/results/k1"))).toHaveLength(1);
  });
});
