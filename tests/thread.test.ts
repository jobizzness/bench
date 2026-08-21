import { describe, it, expect } from "vitest";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendEntry, readThread } from "../src/daemon/thread.js";

async function threadPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "bench-thread-"));
  return join(dir, "thread.jsonl");
}

describe("thread store", () => {
  it("returns an empty thread when nothing has been written", async () => {
    expect(await readThread(await threadPath())).toEqual([]);
  });

  it("appends and reads back an entry", async () => {
    const path = await threadPath();
    await appendEntry(path, { kind: "user", body: "why zod?" });

    const entries = await readThread(path);
    expect(entries).toHaveLength(1);
    expect(entries[0].kind).toBe("user");
    expect(entries[0].body).toBe("why zod?");
  });

  it("numbers entries from one, in write order", async () => {
    const path = await threadPath();
    await appendEntry(path, { kind: "user", body: "first" });
    await appendEntry(path, { kind: "reply", body: "second" });
    await appendEntry(path, { kind: "report", body: "third", reportSeq: 4 });

    const entries = await readThread(path);
    expect(entries.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(entries.map((e) => e.body)).toEqual(["first", "second", "third"]);
  });

  it("stamps each entry with a timestamp", async () => {
    const path = await threadPath();
    await appendEntry(path, { kind: "user", body: "x" });
    const [entry] = await readThread(path);
    expect(Number.isNaN(Date.parse(entry.at))).toBe(false);
  });

  it("carries reportSeq on report entries", async () => {
    const path = await threadPath();
    await appendEntry(path, { kind: "report", body: "Token expiry", reportSeq: 2 });
    const [entry] = await readThread(path);
    expect(entry.reportSeq).toBe(2);
  });

  it("preserves newlines in a body", async () => {
    const path = await threadPath();
    await appendEntry(path, { kind: "reply", body: "line one\nline two" });
    const [entry] = await readThread(path);
    expect(entry.body).toBe("line one\nline two");
  });

  it("skips corrupt lines rather than failing the whole thread", async () => {
    const path = await threadPath();
    await appendEntry(path, { kind: "user", body: "good" });
    await appendEntry(path, { kind: "user", body: "also good" });

    // Splice a broken line between the two valid ones.
    const raw = await readFile(path, "utf8");
    await writeFile(path, raw.replace("\n", "\n{ not json }\n"));

    const entries = await readThread(path);
    expect(entries.map((e) => e.body)).toEqual(["good", "also good"]);
    expect(entries.map((e) => e.seq)).toEqual([1, 2]);
  });

  it("creates the directory if it does not exist yet", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bench-thread-"));
    const path = join(dir, "nested", "deeper", "thread.jsonl");
    await appendEntry(path, { kind: "user", body: "made it" });
    expect((await readThread(path))[0].body).toBe("made it");
  });
});
