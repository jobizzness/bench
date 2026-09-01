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
