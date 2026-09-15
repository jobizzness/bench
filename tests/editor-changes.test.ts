import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fetchChanges, fetchBaseBlob } from "../editor/vscode/src/changes.js";

/**
 * The extension's reads from the daemon. Against a real HTTP server rather
 * than a mocked `fetch`, because the mistakes worth catching here are about
 * what actually goes on the wire - the token header, and a path with a
 * space or a `#` in it surviving the query string.
 */
let server: Server | null = null;
afterEach(() => { server?.close(); server = null; });

interface Seen { url: string; token: string | undefined }

async function daemon(reply: (url: URL) => { status: number; body: unknown }) {
  const seen: Seen[] = [];
  server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    seen.push({ url: req.url ?? "", token: req.headers["x-bench-token"] as string | undefined });
    const { status, body } = reply(url);
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  });
  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
  const { port } = server!.address() as AddressInfo;
  return { base: `http://127.0.0.1:${port}`, seen };
}

describe("fetchChanges", () => {
  it("asks the session's changes route and carries the token", async () => {
    const files = [{ path: "src/x.ts", status: "M", committed: false }];
    const d = await daemon(() => ({ status: 200, body: { base: "abc123", files } }));

    const changes = await fetchChanges(d.base, "tok", "s1");

    expect(changes).toEqual({ base: "abc123", files });
    expect(d.seen[0].url).toBe("/api/sessions/s1/changes");
    expect(d.seen[0].token).toBe("tok");
  });

  /** A specialist that has been closed while the sidebar was open. Nothing
   * to show is not an error worth a dialog. */
  it("gives back nothing for a session the daemon does not know", async () => {
    const d = await daemon(() => ({ status: 404, body: { error: "no such session" } }));
    expect(await fetchChanges(d.base, "tok", "gone")).toEqual({ base: null, files: [] });
  });

  it("gives back nothing rather than throwing when the daemon is down", async () => {
    // Nothing is listening on this port.
    expect(await fetchChanges("http://127.0.0.1:1", "tok", "s1")).toEqual({ base: null, files: [] });
  });
});

describe("fetchBaseBlob", () => {
  it("asks for one file at the base commit", async () => {
    const d = await daemon(() => ({ status: 200, body: { content: "before\n" } }));

    expect(await fetchBaseBlob(d.base, "tok", "s1", "src/x.ts")).toBe("before\n");
    expect(d.seen[0].url).toBe("/api/sessions/s1/blob?path=src%2Fx.ts");
  });

  /**
   * A `#` in a filename would otherwise truncate the query at the fragment,
   * and the daemon would be asked for a different file entirely.
   */
  it("encodes a path that would otherwise break the query string", async () => {
    const d = await daemon(() => ({ status: 200, body: { content: "x" } }));

    await fetchBaseBlob(d.base, "tok", "s1", "src/a b#c.ts");
    expect(d.seen[0].url).toBe("/api/sessions/s1/blob?path=src%2Fa%20b%23c.ts");
  });

  it("gives back empty for a file the daemon will not serve", async () => {
    const d = await daemon(() => ({ status: 404, body: { error: "not available" } }));
    // Empty rather than null: the diff still opens, and reads as all-new.
    expect(await fetchBaseBlob(d.base, "tok", "s1", "src/x.ts")).toBe("");
  });
});
