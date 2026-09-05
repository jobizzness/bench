/**
 * @vitest-environment jsdom
 * @vitest-environment-options { "url": "http://localhost/?token=t" }
 */
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

/**
 * What the cockpit must never spend Firestore on.
 *
 * Three separate leaks, all of which made a signed-in cockpit sitting on the
 * developer's own desk drive its own daemon's full watched loop - 60,456
 * reads a day - to render a roster it already had over the local socket:
 *
 * - It heartbeated presence to *every* machine on the account, including the
 *   one that served the page, so the daemon believed it had a viewer.
 * - The heartbeat's effect depended on `byMachine`, a fresh Map on every
 *   mirror update, so it re-ran and beat again on every roster change rather
 *   than once a minute.
 * - `stopWatching` existed but was never called, so a hidden or closed page
 *   held the daemon awake for the full three-minute stale window.
 */
const { listeners, currentUser, onSnapshotMock, updateDocMock, setDocMock, deleteFieldMock } = vi.hoisted(() => ({
  listeners: new Map<string, (snap: unknown) => void>(),
  currentUser: { value: null as { uid: string } | null },
  onSnapshotMock: vi.fn((ref: { path: string }, cb: (s: unknown) => void) => {
    listeners.set(ref.path, cb);
    return () => listeners.delete(ref.path);
  }),
  updateDocMock: vi.fn(async () => {}),
  setDocMock: vi.fn(async () => {}),
  deleteFieldMock: vi.fn(() => "DELETE_FIELD"),
}));

vi.mock("firebase/app", () => ({ initializeApp: vi.fn(() => ({})) }));
vi.mock("firebase/auth", () => ({ getAuth: vi.fn(() => ({ get currentUser() { return currentUser.value; } })) }));
vi.mock("firebase/firestore", () => ({
  getFirestore: vi.fn(() => ({})),
  doc: vi.fn((_db: unknown, path: string) => ({ path })),
  collection: vi.fn((_db: unknown, path: string) => ({ path })),
  onSnapshot: onSnapshotMock,
  updateDoc: updateDocMock,
  setDoc: setDocMock,
  deleteField: deleteFieldMock,
  deleteDoc: vi.fn(async () => {}),
  persistentLocalCache: vi.fn(() => ({})),
  initializeFirestore: vi.fn(() => ({})),
}));

const { useRoster } = await import("../src/client/components/useRoster.js");
const { encode } = await import("../src/shared/remote-codec.js");

/** This machine, as its own daemon knows it - what `GET /api/remote` says. */
const LOCAL_MACHINE = "m-local";

function emitCollection(path: string, docs: Array<{ id: string; data: Record<string, unknown> }>) {
  listeners.get(path)?.({ docs: docs.map((d) => ({ id: d.id, data: () => d.data })) });
}
function emitDoc(path: string, data: Record<string, unknown> | null) {
  listeners.get(path)?.({ exists: () => data !== null, data: () => data });
}

function row(id: string, over: Record<string, unknown> = {}) {
  return {
    id, label: id, role: "specialist", branch: "b", isolated: true, project: "/p",
    model: "opus", status: "running", detail: "ready", latestReportSeq: null,
    answeredReportSeq: null, startedAt: null, tokens: 0, context: null, activity: [],
    spend: null, answeredBy: null, createdBy: null, pendingPrompt: null, broadcast: true,
    ...over,
  };
}

let root: Root | null = null;
let host: HTMLElement | null = null;

function Probe({ watching = null }: { watching?: string | null }) {
  useRoster(watching);
  return null;
}

/** Mounts the cockpit with `GET /api/remote` answering as `machineId`, or
 * refusing outright - which is what the hosted copy, with no daemon of its
 * own on this origin, actually gets. */
async function mount(machineId: string | null, watching: string | null = null) {
  (globalThis as any).fetch = vi.fn(async (url: string) => {
    if (String(url).includes("/api/remote")) {
      if (machineId === null) return new Response("not found", { status: 404 });
      return new Response(JSON.stringify({ machineId }), { status: 200 });
    }
    return new Response("{}", { status: 404 });
  });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => { root!.render(<Probe watching={watching} />); });
  await act(async () => {});
}

/** The presence documents this page has written a heartbeat to. */
const beatenMachines = () =>
  updateDocMock.mock.calls
    .filter((c: any) => c[2] !== "DELETE_FIELD")
    .map((c: any) => String(c[0].path).split("/")[3]);

/** The presence documents this page has withdrawn its viewer entry from. */
const droppedMachines = () =>
  updateDocMock.mock.calls
    .filter((c: any) => c[2] === "DELETE_FIELD")
    .map((c: any) => String(c[0].path).split("/")[3]);

beforeEach(() => {
  Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
});

afterEach(() => {
  act(() => { root?.unmount(); });
  host?.remove();
  root = null;
  host = null;
  listeners.clear();
  currentUser.value = null;
  onSnapshotMock.mockClear();
  updateDocMock.mockClear();
  setDocMock.mockClear();
});

describe("the cockpit and the machine that served it", () => {
  it("never heartbeats presence to its own machine", async () => {
    currentUser.value = { uid: "u1" };
    await mount(LOCAL_MACHINE);

    emitCollection("users/u1/machines", [
      { id: LOCAL_MACHINE, data: { name: "desktop", lastSeen: Date.now() } },
      { id: "m2", data: { name: "laptop", lastSeen: Date.now() } },
    ]);
    await act(async () => {});

    expect(beatenMachines()).toEqual(["m2"]);
    expect(beatenMachines()).not.toContain(LOCAL_MACHINE);
  });

  it("never listens to its own machine's mirror", async () => {
    currentUser.value = { uid: "u1" };
    await mount(LOCAL_MACHINE);

    emitCollection("users/u1/machines", [
      { id: LOCAL_MACHINE, data: { name: "desktop", lastSeen: Date.now() } },
      { id: "m2", data: { name: "laptop", lastSeen: Date.now() } },
    ]);
    await act(async () => {});

    const watched = onSnapshotMock.mock.calls.map((c: any) => c[0].path);
    expect(watched).toContain("users/u1/machines/m2/mirror/roster");
    expect(watched).not.toContain(`users/u1/machines/${LOCAL_MACHINE}/mirror/roster`);
  });

  it("still watches every machine when there is no local daemon at all", async () => {
    currentUser.value = { uid: "u1" };
    await mount(null); // the hosted cockpit: /api/remote answers 404

    emitCollection("users/u1/machines", [
      { id: "m2", data: { name: "laptop", lastSeen: Date.now() } },
      { id: "m3", data: { name: "desktop", lastSeen: Date.now() } },
    ]);
    await act(async () => {});

    expect(beatenMachines().sort()).toEqual(["m2", "m3"]);
  });
});

describe("the heartbeat's cadence", () => {
  it("does not beat again just because the roster mirror changed", async () => {
    currentUser.value = { uid: "u1" };
    await mount(LOCAL_MACHINE);

    emitCollection("users/u1/machines", [{ id: "m2", data: { name: "laptop", lastSeen: Date.now() } }]);
    await act(async () => {});
    const afterDiscovery = beatenMachines().length;

    // A minute of a watched live turn, at the mirror's 2s coalescing floor.
    // No time passes, so the 60s interval never fires.
    for (let i = 1; i <= 30; i++) {
      emitDoc("users/u1/machines/m2/mirror/roster", { payload: encode([row("s9", { tokens: i })]) });
      await act(async () => {});
    }

    expect(beatenMachines().length - afterDiscovery).toBe(0);
  });
});

describe("a viewer on the way out", () => {
  it("withdraws its presence entry when the page is hidden", async () => {
    currentUser.value = { uid: "u1" };
    await mount(LOCAL_MACHINE);

    emitCollection("users/u1/machines", [{ id: "m2", data: { name: "laptop", lastSeen: Date.now() } }]);
    await act(async () => {});
    expect(droppedMachines()).toEqual([]);

    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });

    expect(droppedMachines()).toEqual(["m2"]);
  });

  it("withdraws its presence entry when the page goes away", async () => {
    currentUser.value = { uid: "u1" };
    await mount(LOCAL_MACHINE);

    emitCollection("users/u1/machines", [{ id: "m2", data: { name: "laptop", lastSeen: Date.now() } }]);
    await act(async () => {});

    await act(async () => { window.dispatchEvent(new Event("pagehide")); });

    expect(droppedMachines()).toEqual(["m2"]);
  });

  it("beats again as soon as the page comes back", async () => {
    currentUser.value = { uid: "u1" };
    await mount(LOCAL_MACHINE);

    emitCollection("users/u1/machines", [{ id: "m2", data: { name: "laptop", lastSeen: Date.now() } }]);
    await act(async () => {});
    const beforeHiding = beatenMachines().length;

    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
    await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });

    expect(beatenMachines().length).toBe(beforeHiding + 1);
  });
});
