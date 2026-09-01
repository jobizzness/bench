/**
 * @vitest-environment jsdom
 * @vitest-environment-options { "url": "http://localhost/?token=t" }
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

/**
 * The merged roster's remote half: nothing without a signed-in Firebase user,
 * and once there is one, rows from another machine's mirror show up tagged
 * with it. `firebase/firestore` is faked at the module boundary the same way
 * `remote-ui.test.tsx` fakes `firebase/auth` for `signInWithPopup` - a tiny
 * path-keyed pub/sub standing in for `onSnapshot`.
 */
const { listeners, currentUser, onSnapshotMock, setDocMock } = vi.hoisted(() => ({
  listeners: new Map<string, (snap: unknown) => void>(),
  currentUser: { value: null as { uid: string } | null },
  onSnapshotMock: vi.fn((ref: { path: string }, cb: (s: unknown) => void) => {
    listeners.set(ref.path, cb);
    return () => listeners.delete(ref.path);
  }),
  setDocMock: vi.fn(async () => {}),
}));

vi.mock("firebase/app", () => ({ initializeApp: vi.fn(() => ({})) }));
vi.mock("firebase/auth", () => ({ getAuth: vi.fn(() => ({ get currentUser() { return currentUser.value; } })) }));
vi.mock("firebase/firestore", () => ({
  getFirestore: vi.fn(() => ({})),
  doc: vi.fn((_db: unknown, path: string) => ({ path })),
  collection: vi.fn((_db: unknown, path: string) => ({ path })),
  onSnapshot: onSnapshotMock,
  setDoc: setDocMock,
  deleteDoc: vi.fn(async () => {}),
  persistentLocalCache: vi.fn(() => ({})),
  initializeFirestore: vi.fn(() => ({})),
}));

const { useRoster } = await import("../src/client/components/useRoster.js");
const { encode } = await import("../src/shared/remote-codec.js");

function emitCollection(path: string, docs: Array<{ id: string; data: Record<string, unknown> }>) {
  listeners.get(path)?.({ docs: docs.map((d) => ({ id: d.id, data: () => d.data })) });
}

function emitDoc(path: string, data: Record<string, unknown> | null) {
  listeners.get(path)?.({ exists: () => data !== null, data: () => data });
}

let root: Root | null = null;
let host: HTMLElement | null = null;
let latest: { rows: any[]; live: boolean | null } | null = null;

function Probe({ watching = null }: { watching?: string | null }) {
  latest = useRoster(watching);
  return null;
}

function mount(watching: string | null = null): void {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => { root!.render(<Probe watching={watching} />); });
}

afterEach(() => {
  act(() => { root?.unmount(); });
  host?.remove();
  root = null;
  host = null;
  latest = null;
  listeners.clear();
  currentUser.value = null;
  onSnapshotMock.mockClear();
  setDocMock.mockClear();
});

describe("useRoster with nobody signed into Firebase", () => {
  it("never calls onSnapshot at all", async () => {
    mount();
    await act(async () => {});
    expect(onSnapshotMock).not.toHaveBeenCalled();
    expect(latest?.rows).toEqual([]);
  });
});

describe("useRoster with a signed-in Firebase user", () => {
  it("merges in a broadcast row from another machine's mirror", async () => {
    currentUser.value = { uid: "u1" };
    mount();
    await act(async () => {});

    emitCollection("users/u1/machines", [{ id: "m2", data: { name: "desktop", lastSeen: Date.now() } }]);
    await act(async () => {});

    const rosterRow = {
      id: "s9", label: "far away", role: "specialist", branch: "b", isolated: true, project: "/p",
      model: "opus", status: "awaiting_decision", detail: "ready", latestReportSeq: null,
      answeredReportSeq: null, startedAt: null, tokens: 0, context: null, activity: [],
      spend: null, answeredBy: null, createdBy: null, pendingPrompt: null, broadcast: true,
    };
    emitDoc("users/u1/machines/m2/mirror/roster", { payload: encode([rosterRow]) });
    await act(async () => {});

    expect(latest?.rows).toHaveLength(1);
    expect(latest?.rows[0].id).toBe("s9");
    expect(latest?.rows[0].machine).toEqual({ id: "m2", name: "desktop", asleep: false });
  });

  it("heartbeats every known machine once mounted", async () => {
    currentUser.value = { uid: "u1" };
    mount();
    await act(async () => {});
    emitCollection("users/u1/machines", [{ id: "m2", data: { name: "desktop", lastSeen: Date.now() } }]);
    await act(async () => {});

    const [ref, data] = setDocMock.mock.calls[0] as [{ path: string }, { watching: string }];
    expect(ref.path).toMatch(/^users\/u1\/machines\/m2\/viewers\//);
    expect(data.watching).toBe("");
  });

  it("marks a machine with no recent heartbeat as asleep", async () => {
    currentUser.value = { uid: "u1" };
    mount();
    await act(async () => {});
    emitCollection("users/u1/machines", [{ id: "m2", data: { name: "desktop", lastSeen: Date.now() - 10 * 60_000 } }]);
    await act(async () => {});
    emitDoc("users/u1/machines/m2/mirror/roster", { payload: encode([{ id: "s9", broadcast: true } as any]) });
    await act(async () => {});

    expect(latest?.rows[0].machine.asleep).toBe(true);
  });
});
