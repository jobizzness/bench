import { describe, it, expect, afterEach } from "vitest";
import { WebSocketServer, type WebSocket as ServerSocket } from "ws";
import type { AddressInfo } from "node:net";
import { EditFollower, type FollowState } from "../editor/vscode/src/follow.js";
import { waitFor } from "./helpers/wait-for.js";

/**
 * The extension's half of the wire. Tested against a real socket server
 * rather than a mock, because the failure that matters - a follower that
 * connects once, loses the daemon and never comes back - only exists between
 * two processes.
 */
const edit = (path: string) => JSON.stringify({
  type: "edit", id: "s1", label: "auth", project: "/var/www/bench",
  tool: "Edit", path, at: "2026-09-15T00:00:00.000Z",
});

let stop: (() => void) | null = null;
afterEach(() => { stop?.(); stop = null; });

/** A stand-in daemon that hands back the sockets it accepts. */
async function daemon() {
  const wss = new WebSocketServer({ port: 0, path: "/events" });
  await new Promise((r) => wss.once("listening", r));
  const sockets: ServerSocket[] = [];
  wss.on("connection", (socket) => sockets.push(socket));
  const { port } = wss.address() as AddressInfo;
  return {
    url: `ws://127.0.0.1:${port}/events?token=t`,
    sockets,
    close: () => new Promise<void>((r) => { for (const s of sockets) s.terminate(); wss.close(() => r()); }),
  };
}

function follower(url: string | null, retryMs = 20) {
  const opened: string[] = [];
  const states: FollowState[] = [];
  const f = new EditFollower({
    url: () => url,
    open: (e) => opened.push(e.path),
    onState: (s) => states.push(s),
    retryMs,
  });
  stop = () => f.stop();
  return { f, opened, states };
}

describe("following a daemon's edits", () => {
  it("opens the file an edit names", async () => {
    const d = await daemon();
    const { f, opened } = follower(d.url);
    f.start();

    await waitFor(() => d.sockets.length || null, "the follower to connect");
    d.sockets[0].send(edit("/var/www/bench/src/x.ts"));

    await waitFor(() => opened.length || null, "the file to be opened");
    expect(opened).toEqual(["/var/www/bench/src/x.ts"]);
    await d.close();
  });

  it("ignores the roster it is not there for", async () => {
    const d = await daemon();
    const { f, opened } = follower(d.url);
    f.start();

    await waitFor(() => d.sockets.length || null, "the follower to connect");
    d.sockets[0].send(JSON.stringify({ type: "roster", rows: [] }));
    d.sockets[0].send(edit("/var/www/bench/src/x.ts"));

    await waitFor(() => opened.length || null, "the file to be opened");
    // One open, from the edit - the roster produced nothing.
    expect(opened).toEqual(["/var/www/bench/src/x.ts"]);
    await d.close();
  });

  it("survives a frame that is not JSON", async () => {
    const d = await daemon();
    const { f, opened } = follower(d.url);
    f.start();

    await waitFor(() => d.sockets.length || null, "the follower to connect");
    d.sockets[0].send("{ not json");
    d.sockets[0].send(edit("/var/www/bench/src/x.ts"));

    await waitFor(() => opened.length || null, "the file to be opened");
    expect(opened).toEqual(["/var/www/bench/src/x.ts"]);
    await d.close();
  });

  /**
   * Turning following off has to leave the socket up. A toggle that
   * disconnected would drop every edit made while it was off and then need a
   * reconnect to come back, which is a different feature wearing the same
   * label.
   */
  it("stops opening files when paused, without dropping the connection", async () => {
    const d = await daemon();
    const { f, opened } = follower(d.url);
    f.start();

    await waitFor(() => d.sockets.length || null, "the follower to connect");
    f.following = false;
    d.sockets[0].send(edit("/var/www/bench/src/ignored.ts"));
    await new Promise((r) => setTimeout(r, 50));
    expect(opened).toEqual([]);

    f.following = true;
    d.sockets[0].send(edit("/var/www/bench/src/wanted.ts"));
    await waitFor(() => opened.length || null, "the file to be opened");

    expect(opened).toEqual(["/var/www/bench/src/wanted.ts"]);
    // Still the one connection: nothing reconnected to resume.
    expect(d.sockets).toHaveLength(1);
    await d.close();
  });

  /**
   * The daemon gets restarted all day. A follower that needs a window reload
   * to notice is one the developer turns off.
   */
  it("comes back after the daemon restarts", async () => {
    const first = await daemon();
    const { f, opened } = follower(first.url);
    f.start();

    await waitFor(() => first.sockets.length || null, "the first connection");
    await first.close();

    // The daemon comes back on the same port the follower already knows.
    const port = new URL(first.url).port;
    const again = new WebSocketServer({ port: Number(port), path: "/events" });
    const reconnected: ServerSocket[] = [];
    again.on("connection", (s) => reconnected.push(s));

    await waitFor(() => reconnected.length || null, "the follower to reconnect", 5000);
    reconnected[0].send(edit("/var/www/bench/src/after.ts"));

    await waitFor(() => opened.length || null, "a file opened on the new connection");
    expect(opened).toEqual(["/var/www/bench/src/after.ts"]);

    for (const s of reconnected) s.terminate();
    await new Promise<void>((r) => again.close(() => r()));
  });

  it("reports having no token rather than connecting to nothing", async () => {
    const { f, states } = follower(null);
    f.start();
    await waitFor(() => states.includes("no-token") || null, "the missing token to be reported");
    expect(states).toContain("no-token");
  });

  it("stops for good when told to", async () => {
    const d = await daemon();
    const { f, opened } = follower(d.url);
    f.start();

    await waitFor(() => d.sockets.length || null, "the follower to connect");
    f.stop();
    await new Promise((r) => setTimeout(r, 60));

    // Nothing reconnected in the window that a restart would have used.
    expect(d.sockets).toHaveLength(1);
    expect(opened).toEqual([]);
    await d.close();
  });
});
