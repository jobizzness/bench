/**
 * @vitest-environment jsdom
 * @vitest-environment-options { "url": "http://localhost/?token=t" }
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

/**
 * The bug this ticket was reopened for: `useSessionPlan` polling
 * `authFetch` every 2s over the relay is 60 writes a minute against a
 * 20,000/day ceiling. A relayed session must read the mirror instead of
 * ever calling `authFetch` for its plan - proven here by mocking
 * `firebase/firestore` and asserting `fetch` is never called while the
 * mirror is what actually feeds the hook.
 */
const { listeners, onSnapshotMock } = vi.hoisted(() => ({
  listeners: new Map<string, (snap: unknown) => void>(),
  onSnapshotMock: vi.fn((ref: { path: string }, cb: (s: unknown) => void) => {
    listeners.set(ref.path, cb);
    return () => listeners.delete(ref.path);
  }),
}));

vi.mock("firebase/app", () => ({ initializeApp: vi.fn(() => ({})) }));
vi.mock("firebase/firestore", () => ({
  getFirestore: vi.fn(() => ({})),
  initializeFirestore: vi.fn(() => ({})),
  persistentLocalCache: vi.fn(() => ({})),
  doc: vi.fn((_db: unknown, path: string) => ({ path })),
  onSnapshot: onSnapshotMock,
}));

const { useSessionPlan } = await import("../src/client/components/useSessionPlan.js");
const { routeSession } = await import("../src/client/api.js");
const { encode } = await import("../src/shared/remote-codec.js");

function emitDoc(path: string, data: Record<string, unknown> | null) {
  listeners.get(path)?.({ exists: () => data !== null, data: () => data });
}

let root: Root | null = null;
let host: HTMLElement | null = null;
let latest: unknown = "unset";

function Probe({ id, live }: { id: string | null; live: boolean }) {
  latest = useSessionPlan(id, live);
  return null;
}

function mount(id: string | null, live: boolean): void {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => { root!.render(<Probe id={id} live={live} />); });
}

afterEach(() => {
  act(() => { root?.unmount(); });
  host?.remove();
  root = null;
  host = null;
  latest = "unset";
  listeners.clear();
  onSnapshotMock.mockClear();
  routeSession("s-remote", null);
  vi.unstubAllGlobals();
});

describe("useSessionPlan for a session on another machine", () => {
  it("never calls fetch - it listens to the mirror instead of polling", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    routeSession("s-remote", { uid: "u1", machineId: "m1" });

    mount("s-remote", true);
    await act(async () => {});

    emitDoc("users/u1/machines/m1/mirror/s-remote", {
      payload: encode({ thread: [], plan: { steps: [{ text: "step one", done: false }] } }),
    });
    await act(async () => {});

    expect(latest).toEqual([{ text: "step one", done: false }]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("reflects the mirror going empty as no plan, not stale steps", async () => {
    routeSession("s-remote", { uid: "u1", machineId: "m1" });
    mount("s-remote", true);
    await act(async () => {});

    emitDoc("users/u1/machines/m1/mirror/s-remote", { payload: encode({ thread: [], plan: { steps: [{ text: "a", done: false }] } }) });
    await act(async () => {});
    expect(latest).toEqual([{ text: "a", done: false }]);

    emitDoc("users/u1/machines/m1/mirror/s-remote", null);
    await act(async () => {});
    expect(latest).toBeNull();
  });
});
