import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import WebSocket from "ws";
import { createServer } from "../src/daemon/server.js";
import { SessionRegistry } from "../src/daemon/registry.js";
import { SessionStore } from "../src/daemon/store.js";
import { RefIndex } from "../src/daemon/refs.js";
import { waitFor } from "./helpers/wait-for.js";

/**
 * The editor-follow path, end to end: a real CLI process writing a real
 * tool call, through the session, the registry and the socket.
 *
 * Every piece of this has a unit test and the feature could still be dead.
 * `fileTouch` can return the right path and the roster trail keep working
 * while nothing forwards the event, and the extension would sit there
 * connected and silent with no test failing anywhere. See #122.
 */
const TOKEN = "edit-token";

/** Emits one tool call per prompt, then ends the turn. */
function toolCallingCli(tool: string, input: Record<string, unknown>): string {
  return `#!/usr/bin/env node
process.stdout.write(JSON.stringify({ type: "system", subtype: "init" }) + "\\n");
let carry = "";
process.stdin.on("data", (chunk) => {
  carry += chunk.toString();
  const lines = carry.split("\\n");
  carry = lines.pop();
  for (const line of lines) {
    if (line.trim() === "") continue;
    process.stdout.write(JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "tool_use", name: ${JSON.stringify(tool)}, input: ${JSON.stringify(input)} }] },
    }) + "\\n");
    process.stdout.write(JSON.stringify({
      type: "result", subtype: "success", is_error: false,
      session_id: "sess-edit", result: "done",
    }) + "\\n");
  }
});
`;
}

async function fakeCli(source: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "bench-fakecli-"));
  const path = join(dir, "fake-claude.mjs");
  await writeFile(path, source);
  await chmod(path, 0o755);
  return path;
}

/** A daemon with one specialist on it, and a socket watching. */
async function bench(cli: string) {
  const home = await mkdtemp(join(tmpdir(), "bench-edit-home-"));
  const project = await mkdtemp(join(tmpdir(), "bench-edit-proj-"));
  const worktree = join(project, ".claude", "worktrees", "auth");
  const id = "sess-edit";
  const reportsDir = join(project, ".bench", "reports", id);
  await mkdir(worktree, { recursive: true });
  await mkdir(reportsDir, { recursive: true });

  await new SessionStore(home).put({
    id, label: "auth", role: "specialist", project, worktree,
    branch: "bench/auth-abcd1234", reportsDir, model: "opus", port: 3101,
    createdAt: "2026-09-15T00:00:00.000Z", isolated: true, resumable: true,
  });

  const config = {
    home, host: "127.0.0.1", port: 0, token: TOKEN,
    pluginDir: "/nonexistent/plugin", hookCommand: "true",
    projectsRoot: project, claudeBin: await fakeCli(cli),
  };

  const registry = new SessionRegistry(config as any);
  await registry.restore();
  const server = createServer({ config, registry, refs: new RefIndex() } as any);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  const frames: any[] = [];
  const socket = new WebSocket(`ws://127.0.0.1:${port}/events?token=${TOKEN}`);
  socket.on("message", (raw) => frames.push(JSON.parse(raw.toString())));
  await new Promise((r) => socket.once("open", r));

  return {
    id, project, worktree, registry, frames,
    stop: () => { socket.close(); server.close(); },
  };
}

describe("file edits on the events socket", () => {
  it("carries the whole path to anything listening", async () => {
    const path = "/var/www/bench/src/daemon/registry.ts";
    const b = await bench(toolCallingCli("Edit", { file_path: path }));
    try {
      b.registry.send(b.id, "change something");

      const frame = await waitFor(
        () => b.frames.find((f) => f.type === "edit"),
        "an edit frame on the socket",
      );

      // The path an editor can open, not the tail the roster shows.
      expect(frame.path).toBe(path);
      expect(frame.tool).toBe("Edit");
      // Which specialist did it - without this the extension cannot say who,
      // and cannot ever follow one of several.
      expect(frame.id).toBe(b.id);
      expect(frame.label).toBe("auth");
      expect(frame.project).toBe(b.project);
      expect(typeof frame.at).toBe("string");
    } finally {
      b.stop();
    }
  });

  it("still sends the roster, and still shortens the path on the trail", async () => {
    const b = await bench(toolCallingCli("Edit", { file_path: "/var/www/bench/src/daemon/registry.ts" }));
    try {
      b.registry.send(b.id, "change something");
      await waitFor(() => b.frames.find((f) => f.type === "edit"), "an edit frame");

      const row = await waitFor(
        () => b.frames.filter((f) => f.type === "roster").at(-1)?.rows?.[0],
        "a roster frame",
      );
      // The phone still gets the trimmed form. Adding a second reading of the
      // event must not change the first one.
      expect(row.activity.at(-1).text).toBe("Edit src/daemon/registry.ts");
    } finally {
      b.stop();
    }
  });

  it("says nothing when a specialist only reads a file", async () => {
    const b = await bench(toolCallingCli("Read", { file_path: "/var/www/bench/README.md" }));
    try {
      b.registry.send(b.id, "go and look");
      // Wait for the turn to have actually happened, so this is not a test
      // that passes by being faster than the process it is watching.
      await waitFor(
        () => b.frames.filter((f) => f.type === "roster").at(-1)?.rows?.[0]?.activity?.length || null,
        "the read to reach the trail",
      );

      expect(b.frames.filter((f) => f.type === "edit")).toHaveLength(0);
    } finally {
      b.stop();
    }
  });
});
