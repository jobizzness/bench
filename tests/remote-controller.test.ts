import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RemoteController } from "../src/daemon/remote/controller.js";
import { loadIdentity } from "../src/daemon/remote/identity-file.js";

const EXCHANGE_OK = { id_token: "id-1", refresh_token: "rt-1", expires_in: "3600", user_id: "u1" };

interface Doc { fields: Record<string, unknown> }

/** A tiny in-memory Firestore, just enough for the controller's own tests -
 * PATCH stores, GET reads, DELETE removes. Good enough to prove machine
 * registration and rename without a network. */
function fakeBackend() {
  const docs = new Map<string, Doc>();
  const calls: Array<{ url: string; method: string }> = [];

  const fetchImpl = (async (url: string, init?: RequestInit) => {
    if (url.includes("securetoken.googleapis.com")) {
      const params = new URLSearchParams(String(init?.body));
      if (params.get("refresh_token") === "dead") {
        return new Response(JSON.stringify({ error: { message: "TOKEN_EXPIRED" } }), { status: 400 });
      }
      return new Response(JSON.stringify(EXCHANGE_OK), { status: 200 });
    }

    const method = init?.method ?? "GET";
    calls.push({ url, method });
    const path = url.split("/documents/")[1];

    if (method === "PATCH") {
      const body = JSON.parse(String(init?.body));
      docs.set(path, body);
      return new Response("{}", { status: 200 });
    }
    if (method === "DELETE") {
      docs.delete(path);
      return new Response("{}", { status: 200 });
    }
    const doc = docs.get(path);
    return doc
      ? new Response(JSON.stringify(doc), { status: 200 })
      : new Response("{}", { status: 404 });
  }) as unknown as typeof fetch;

  return { fetchImpl, docs, calls };
}

async function home(): Promise<string> {
  return mkdtemp(join(tmpdir(), "bench-remote-ctrl-"));
}

function controller(dir: string, fetchImpl: typeof fetch, over: Partial<ConstructorParameters<typeof RemoteController>[0]> = {}) {
  return new RemoteController({
    home: dir, apiKey: "key", projectId: "bench-cockpit", version: "0.1.0",
    fetchImpl, hostname: "dev-laptop", platform: "darwin",
    ...over,
  });
}

describe("connecting", () => {
  afterEach(() => { vi.useRealTimers(); });

  it("reports off before anything has connected", async () => {
    const { fetchImpl } = fakeBackend();
    const remote = controller(await home(), fetchImpl);
    expect(remote.state().connected).toBe(false);
  });

  it("becomes connected, and writes the identity file, once signed in", async () => {
    const dir = await home();
    const { fetchImpl, docs } = fakeBackend();
    const remote = controller(dir, fetchImpl);

    const state = await remote.connect("rt-0", "u1");

    expect(state.connected).toBe(true);
    expect(state.uid).toBe("u1");
    expect(state.tokenExpiresAt).toBeGreaterThan(Date.now());
    expect(loadIdentity(dir)?.uid).toBe("u1");
    expect(docs.has("users/u1/machines/" + state.machineId)).toBe(true);
  });

  it("is mode 0600 on disk, the same treatment as ~/.bench/token", async () => {
    const dir = await home();
    const { fetchImpl } = fakeBackend();
    await controller(dir, fetchImpl).connect("rt-0", "u1");
    const mode = (await stat(join(dir, "firebase.json"))).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("defaults the machine name to the hostname", async () => {
    const { fetchImpl } = fakeBackend();
    const remote = controller(await home(), fetchImpl);
    const state = await remote.connect("rt-0", "u1");
    expect(state.machineName).toBe("dev-laptop");
  });

  it("rejects connect() with a bad refresh token rather than leaving remote half-on", async () => {
    const remote = controller(await home(), fakeBackend().fetchImpl);
    await expect(remote.connect("dead", "u1")).rejects.toThrow();
    expect(remote.state().connected).toBe(false);
  });
});

describe("restarting the daemon", () => {
  it("resumes without a second sign-in, using the identity file", async () => {
    const dir = await home();
    const backend = fakeBackend();
    await controller(dir, backend.fetchImpl).connect("rt-0", "u1");

    const restarted = controller(dir, backend.fetchImpl);
    await restarted.resume();

    expect(restarted.state().connected).toBe(true);
    expect(restarted.state().uid).toBe("u1");
  });

  it("does not mint a second machine id on resume", async () => {
    const dir = await home();
    const backend = fakeBackend();
    const first = await controller(dir, backend.fetchImpl).connect("rt-0", "u1");

    const restarted = controller(dir, backend.fetchImpl);
    await restarted.resume();

    expect(restarted.state().machineId).toBe(first.machineId);
  });

  it("does not mint a second machine id when the same account signs in again without restarting", async () => {
    const dir = await home();
    const backend = fakeBackend();
    const remote = controller(dir, backend.fetchImpl);
    const first = await remote.connect("rt-0", "u1");
    const second = await remote.connect("rt-0", "u1");
    expect(second.machineId).toBe(first.machineId);
  });

  it("does nothing, and is not an error, when there is no identity file to resume", async () => {
    const remote = controller(await home(), fakeBackend().fetchImpl);
    await expect(remote.resume()).resolves.toBeUndefined();
    expect(remote.state().connected).toBe(false);
  });
});

describe("two machines under one account", () => {
  it("register as two distinct machine documents", async () => {
    const dir1 = await home();
    const dir2 = await home();
    const backend = fakeBackend();

    const laptop1 = await controller(dir1, backend.fetchImpl, { hostname: "laptop-1" }).connect("rt-0", "u1");
    const laptop2 = await controller(dir2, backend.fetchImpl, { hostname: "laptop-2" }).connect("rt-0", "u1");

    expect(laptop1.machineId).not.toBe(laptop2.machineId);
    expect(backend.docs.has("users/u1/machines/" + laptop1.machineId)).toBe(true);
    expect(backend.docs.has("users/u1/machines/" + laptop2.machineId)).toBe(true);
  });
});

describe("a revoked refresh token", () => {
  it("surfaces as an error rather than throwing out of resume()", async () => {
    const dir = await home();
    const backend = fakeBackend();
    // A file left behind by a refresh token the account has since revoked.
    const { saveIdentity } = await import("../src/daemon/remote/identity-file.js");
    saveIdentity(dir, { uid: "u1", refreshToken: "dead", machineId: "m1" });

    const remote = controller(dir, backend.fetchImpl);
    await remote.resume();

    expect(remote.state().connected).toBe(false);
    expect(remote.state().error).toBe("remote is off, sign in again");
  });

  it("does not crash-loop: no further exchange attempts once rejected", async () => {
    vi.useFakeTimers();
    const dir = await home();
    let exchanges = 0;
    const fetchImpl = (async (url: string) => {
      if (url.includes("securetoken")) {
        exchanges += 1;
        return exchanges === 1
          ? new Response(JSON.stringify(EXCHANGE_OK), { status: 200 })
          : new Response(JSON.stringify({ error: { message: "TOKEN_EXPIRED" } }), { status: 400 });
      }
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    const remote = controller(dir, fetchImpl, { heartbeatMs: 1000 });
    await remote.connect("rt-0", "u1");
    expect(exchanges).toBe(1);

    await vi.advanceTimersByTimeAsync(55 * 60 * 1000);
    expect(remote.state().connected).toBe(false);
    expect(remote.state().error).toBe("remote is off, sign in again");

    const after = exchanges;
    await vi.advanceTimersByTimeAsync(6 * 60 * 60 * 1000);
    expect(exchanges).toBe(after);
    vi.useRealTimers();
  });
});

describe("renaming this machine", () => {
  it("updates the name Settings shows, and the machine document", async () => {
    const dir = await home();
    const backend = fakeBackend();
    const remote = controller(dir, backend.fetchImpl);
    const connected = await remote.connect("rt-0", "u1");

    const renamed = await remote.renameMachine("kitchen table");

    expect(renamed.machineName).toBe("kitchen table");
    const doc = backend.docs.get("users/u1/machines/" + connected.machineId);
    expect((doc as any)?.fields.name.stringValue).toBe("kitchen table");
  });

  it("a rename survives a restart - resume reads the name back rather than resetting it to the hostname", async () => {
    const dir = await home();
    const backend = fakeBackend();
    const first = controller(dir, backend.fetchImpl);
    await first.connect("rt-0", "u1");
    await first.renameMachine("kitchen table");

    const restarted = controller(dir, backend.fetchImpl);
    await restarted.resume();

    expect(restarted.state().machineName).toBe("kitchen table");
  });

  it("refuses to rename when remote is off", async () => {
    const remote = controller(await home(), fakeBackend().fetchImpl);
    await expect(remote.renameMachine("x")).rejects.toThrow();
  });
});

describe("turning remote off", () => {
  it("clears the local file, removes the machine document, and reports off", async () => {
    const dir = await home();
    const backend = fakeBackend();
    const remote = controller(dir, backend.fetchImpl);
    const connected = await remote.connect("rt-0", "u1");

    const state = await remote.disconnect();

    expect(state.connected).toBe(false);
    expect(loadIdentity(dir)).toBeNull();
    expect(backend.docs.has("users/u1/machines/" + connected.machineId)).toBe(false);
  });

  it("still clears local state even when the machine document cannot be reached", async () => {
    const dir = await home();
    const backend = fakeBackend();
    let broken = false;
    const flaky = (async (url: string, init?: RequestInit) => {
      if (broken && !url.includes("securetoken")) throw new Error("offline");
      return (backend.fetchImpl as unknown as (u: string, i?: RequestInit) => Promise<Response>)(url, init);
    }) as unknown as typeof fetch;

    const remote = controller(dir, flaky);
    const connected = await remote.connect("rt-0", "u1");
    broken = true;

    const state = await remote.disconnect();

    expect(state.connected).toBe(false);
    expect(loadIdentity(dir)).toBeNull();
    // Firestore still has the document - deregistering it could not reach the
    // network, and "off" locally still had to happen anyway.
    expect(backend.docs.has("users/u1/machines/" + connected.machineId)).toBe(true);
  });
});
