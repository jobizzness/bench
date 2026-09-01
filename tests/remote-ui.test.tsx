/**
 * @vitest-environment jsdom
 * @vitest-environment-options { "url": "http://localhost/?token=t" }
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { bootCockpit, row, type Cockpit, type Fixtures } from "./helpers/cockpit.js";
import { waitFor } from "./helpers/wait-for.js";
import { signInWithPopup } from "firebase/auth";

/**
 * "Turn on remote" never touches Google for real in a test - `signInWithPopup`
 * is the one call in the cockpit that is not `authFetch`, and these tests
 * stand in for what a real popup would hand back.
 */
vi.mock("firebase/app", () => ({ initializeApp: vi.fn(() => ({})) }));
vi.mock("firebase/auth", () => ({
  getAuth: vi.fn(() => ({})),
  GoogleAuthProvider: vi.fn(function GoogleAuthProvider(this: unknown) {}),
  signInWithPopup: vi.fn(),
}));

const popup = vi.mocked(signInWithPopup);

let ui: Cockpit;
afterEach(() => {
  ui?.unmount();
  popup.mockReset();
  history.pushState({}, "", "/?token=t");
});

const state = () => ui.$("#s-remote-state")!.textContent ?? "";

async function open(over: Partial<Fixtures> = {}): Promise<void> {
  ui = await bootCockpit({ rows: [row()], ...over });
  await ui.click(ui.$("#open-settings"));
  // Always rendered, regardless of whether the fetch behind it has resolved
  // yet - the two buttons are not, so waiting on either of them can catch the
  // panel mid-render, still showing its default (off) state.
  await waitFor(() => ui.$("#s-remote-state"), "the remote panel");
}

/** For fixtures that connect remote from the start: the panel mounts off
 * (its default state) and switches once `GET /api/remote` resolves, so tests
 * that assume the connected view has to wait for that switch explicitly. */
async function openConnected(over: Partial<Fixtures> = {}): Promise<void> {
  await open(over);
  await waitFor(() => ui.$("#s-remote-off"), "the connected state");
}

describe("the remote control, off", () => {
  it("says specialists stay on this machine", async () => {
    await open();
    expect(state()).toContain("Off");
    expect(ui.$("#s-remote-on")).not.toBeNull();
    expect(ui.$("#s-remote-off")).toBeNull();
  });

  it("signs in with Google and hands the daemon the refresh token and uid", async () => {
    popup.mockResolvedValue({ user: { uid: "u1", refreshToken: "rt-xyz", email: "dev@example.com" } } as any);
    await open();

    await ui.click(ui.$("#s-remote-on"));
    await waitFor(() => ui.$("#s-remote-off"), "the off switch, once connected");

    const sent = ui.sent.find((s) => s.url.endsWith("/api/remote/identity"));
    expect(sent?.body).toEqual({ refreshToken: "rt-xyz", uid: "u1", email: "dev@example.com" });
    expect(state()).toContain("dev@example.com");
  });

  it("shows an error and sends nothing to the daemon when the popup does not complete", async () => {
    popup.mockRejectedValue(new Error("popup closed by user"));
    await open();

    await ui.click(ui.$("#s-remote-on"));
    await waitFor(() => ui.$("#s-remote-error"), "an error");

    expect(ui.sent.find((s) => s.url.includes("/api/remote/identity"))).toBeUndefined();
  });

  it("shows the daemon's own reason when it refuses the identity", async () => {
    popup.mockResolvedValue({ user: { uid: "u1", refreshToken: "rt-xyz", email: null } } as any);
    await open({ remoteReply: { status: 400, body: { error: "that refresh token was rejected" } } });

    await ui.click(ui.$("#s-remote-on"));
    await waitFor(() => ui.$("#s-remote-error"), "an error");

    expect(ui.$("#s-remote-error")!.textContent).toContain("rejected");
    // Still off - a refused sign-in must not draw the switch as though it worked.
    expect(ui.$("#s-remote-off")).toBeNull();
  });
});

describe("the remote control, on", () => {
  const CONNECTED = {
    connected: true, uid: "u1", email: "dev@example.com", machineId: "m1",
    machineName: "dev-laptop", platform: "darwin", tokenExpiresAt: Date.now() + 3_600_000, error: null,
  };

  it("shows which account and which machine", async () => {
    await openConnected({ remote: CONNECTED });
    expect(state()).toContain("dev@example.com");
    expect(ui.$("#s-remote-rename")!.textContent).toBe("dev-laptop");
  });

  it("lets the machine be renamed", async () => {
    await openConnected({ remote: CONNECTED });

    await ui.click(ui.$("#s-remote-rename"));
    await ui.type(ui.$("#s-remote-machine-name"), "kitchen table");
    await ui.pressIn(ui.$("#s-remote-machine-name"), "Enter");

    const sent = ui.sent.find((s) => s.url.endsWith("/api/remote/machine"));
    expect(sent?.body).toEqual({ name: "kitchen table" });
    await waitFor(() => ui.$("#s-remote-rename")?.textContent === "kitchen table", "the renamed machine");
  });

  it("turns remote off, clearing the account and machine", async () => {
    await openConnected({ remote: CONNECTED });

    await ui.click(ui.$("#s-remote-off"));
    await waitFor(() => ui.$("#s-remote-on"), "the on switch, once disconnected");

    expect(ui.sent.some((s) => s.url.endsWith("/api/remote"))).toBe(true);
    expect(state()).toContain("Off");
  });

  it("surfaces a revoked credential as its own message rather than as connected", async () => {
    await open({
      remote: { ...CONNECTED, connected: false, error: "remote is off, sign in again" },
    });
    await waitFor(() => state() === "remote is off, sign in again", "the revoked-credential message");
    expect(ui.$("#s-remote-on")).not.toBeNull();
  });
});
