/**
 * @vitest-environment jsdom
 * @vitest-environment-options { "url": "http://localhost/?token=t" }
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { sendCommand } = vi.hoisted(() => ({ sendCommand: vi.fn() }));
vi.mock("../src/client/remote-transport.js", () => ({ sendCommand }));

import { authFetch, postJson, routeSession, setActiveMachine, loadArtifact, artifactUrl } from "../src/client/api.js";

const MACHINE = { uid: "u1", machineId: "m1" };

beforeEach(() => {
  sendCommand.mockReset();
  routeSession("s1", null); // clears any routing left over from a previous test
});

describe("authFetch, routed by session", () => {
  it("goes direct for a session with no machine registered", async () => {
    sendCommand.mockResolvedValue({ status: 200, contentType: "application/json", text: "{}" });
    const realFetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }));

    await authFetch("/api/sessions/s1/thread");

    expect(realFetch).toHaveBeenCalled();
    expect(sendCommand).not.toHaveBeenCalled();
    realFetch.mockRestore();
  });

  it("goes through sendCommand once the session is routed to another machine", async () => {
    sendCommand.mockResolvedValue({ status: 200, contentType: "application/json", text: JSON.stringify({ ok: true }) });
    const realFetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }));

    routeSession("s1", MACHINE);
    const res = await authFetch("/api/sessions/s1/thread");

    expect(sendCommand).toHaveBeenCalledWith(MACHINE.uid, MACHINE.machineId, "GET", "/api/sessions/s1/thread", undefined);
    expect(realFetch).not.toHaveBeenCalled();
    expect(await res.json()).toEqual({ ok: true });
    realFetch.mockRestore();
  });

  it("decodes a JSON body before handing it to sendCommand, rather than double-encoding it", async () => {
    sendCommand.mockResolvedValue({ status: 200, contentType: "application/json", text: "{}" });
    routeSession("s1", MACHINE);

    await postJson("/api/sessions/s1/message", { text: "hi" });

    expect(sendCommand).toHaveBeenCalledWith(MACHINE.uid, MACHINE.machineId, "POST", "/api/sessions/s1/message", { text: "hi" });
  });

  it("routes a machine-global path by the active machine, not by any session", async () => {
    sendCommand.mockResolvedValue({ status: 200, contentType: "application/json", text: "{}" });
    const realFetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }));

    setActiveMachine(MACHINE);
    await authFetch("/api/settings");
    expect(sendCommand).toHaveBeenCalledWith(MACHINE.uid, MACHINE.machineId, "GET", "/api/settings", undefined);

    setActiveMachine(null);
    await authFetch("/api/settings");
    expect(realFetch).toHaveBeenCalled();
    realFetch.mockRestore();
  });

  /**
   * Stands in for the second machine #139 needed and this suite has no way
   * to spin up: `setActiveMachine` is exactly what `useRoster.ts` calls when
   * a remote row is the one being watched, so setting it here is the same
   * state the cockpit would be in with that remote specialist open. The
   * Profile dialog's three routes (`CredentialSection.tsx`, via `local:
   * true`) must ignore it - a pin has to land on the daemon `pickManagedKey`
   * reads, not on whichever machine's tab is open - while an ordinary
   * machine-global route like `/api/settings` still follows it, unchanged
   * from the test above.
   */
  it("keeps the Profile dialog's routes local even with a remote machine active", async () => {
    sendCommand.mockResolvedValue({ status: 200, contentType: "application/json", text: "{}" });
    const realFetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }));

    setActiveMachine(MACHINE);
    await authFetch("/api/anthropic-keys", undefined, { local: true });
    await postJson("/api/anthropic-keys/pin", { id: "a" }, { local: true });
    await authFetch("/api/openrouter/keys", undefined, { local: true });

    expect(sendCommand).not.toHaveBeenCalled();
    expect(realFetch).toHaveBeenCalledTimes(3);

    setActiveMachine(null);
    realFetch.mockRestore();
  });

  /**
   * `ModelDialog.tsx` asks this exact route, with no `local` flag, about the
   * machine a *session* would run a specialist on - a different question
   * from the Profile dialog's, that happens to share a path. Without this
   * test, forcing `/api/openrouter/keys` local by path alone (the fix's
   * first draft) would have passed every other #139 test while silently
   * breaking model selection for a remote specialist.
   */
  it("still routes /api/openrouter/keys by the active machine when local is not requested", async () => {
    sendCommand.mockResolvedValue({ status: 200, contentType: "application/json", text: "{}" });
    const realFetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }));

    setActiveMachine(MACHINE);
    await authFetch("/api/openrouter/keys");
    expect(sendCommand).toHaveBeenCalledWith(MACHINE.uid, MACHINE.machineId, "GET", "/api/openrouter/keys", undefined);
    expect(realFetch).not.toHaveBeenCalled();

    setActiveMachine(null);
    realFetch.mockRestore();
  });
});

describe("loadArtifact", () => {
  it("returns a plain url for a local session, unchanged from artifactUrl", async () => {
    const content = await loadArtifact("s1", 3, "report.html");
    expect(content).toEqual({ kind: "url", url: artifactUrl("s1", 3, "report.html") });
  });

  it("fetches html for a session on another machine, rather than a url", async () => {
    sendCommand.mockResolvedValue({ status: 200, contentType: "text/html", text: "<html>hi</html>" });
    routeSession("s2", MACHINE);

    const content = await loadArtifact("s2", 1, "report.html");

    expect(content).toEqual({ kind: "html", html: "<html>hi</html>" });
    expect(sendCommand).toHaveBeenCalledWith(
      MACHINE.uid, MACHINE.machineId, "GET", expect.stringContaining("/r/s2/1/report.html"), undefined,
    );
  });
});
