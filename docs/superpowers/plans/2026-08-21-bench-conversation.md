# Bench Conversation and Cockpit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a Bench specialist something you can talk to, and rebuild the cockpit as a conversation.

**Architecture:** Turns gain a kind (`work` or `chat`) set by the developer's action and written to disk beside the existing turn marker; the `Stop` report gate reads it and exempts chat. The daemon gains an append-only thread store per session and a message route distinct from the answer route. The client becomes a three-part cockpit — roster, quiet thread, one composer that turns into the decision when a report lands.

**Tech Stack:** Node 22, pnpm 10, TypeScript strict, `ws`, `zod`, `vitest`. Client stays dependency-free.

**Spec:** `docs/superpowers/specs/2026-08-21-bench-conversation-design.md`

## Global Constraints

- **Node 22, pnpm 10.** Installed: Node `v22.13.1`, pnpm `10.24.0`.
- **`claude` CLI `>= 2.1.238`.** Every flag and wire fact here was verified against it.
- **`--verbose` is mandatory** with `-p --output-format stream-json`.
- **Linux paths only.** The client is given session ids and sequence numbers; it never receives a worktree or report path.
- **No Claude or Anthropic attribution** in any commit message, code comment, or PR.
- **TypeScript strict mode.**
- **Small focused files.** Logic lives in its own module, never in `server.ts`. Shared types live in `src/shared/types.ts`.
- **The gate fails safe.** An unreadable or missing turn kind means `work`, so a bug can never silently disable the report requirement.
- **Accent is reserved.** `--accent` marks only the thing needing action. If it appears twice on screen, one is a bug.
- **Sessions are scoped by project.** The roster groups specialists under a project heading and never renders a flat list. Everything lives in one window; no tab or pane per session. A collapsed project must still surface any specialist inside it that needs attention, so collapsing never hides urgency.

## File Structure

```
src/shared/types.ts            + TurnKind, ThreadEntry, ThreadEntryInput
src/daemon/stream-codec.ts     + replyText()
src/daemon/thread.ts           NEW - append-only per-session thread store
src/daemon/gates/report-required.ts   evaluateStop gains kind
src/daemon/hooks/bench-hook.ts        reads .turn-kind
src/daemon/claude-session.ts   turn kinds, message(), reply event
src/daemon/server.ts           + /message, + /thread routes
src/daemon/index.ts            registry wires the thread store
src/client/index.html          rebuilt: roster, thread, composer
src/client/styles.css          rebuilt: dark green theme
src/client/app.js              rebuilt: thread rendering, composer modes
```

---

### Task 1: Turn kinds

The developer's action sets the kind; the agent never chooses. `work` requires a report, `chat` does not.

**Files:**
- Modify: `src/shared/types.ts`
- Modify: `src/daemon/gates/report-required.ts`
- Modify: `src/daemon/hooks/bench-hook.ts`
- Modify: `src/daemon/claude-session.ts`
- Test: `tests/gates.test.ts`, `tests/claude-session.test.ts`

**Interfaces:**
- Consumes: `evaluateStop({ reportsDir, turn })` as it exists today
- Produces:
  - `type TurnKind = "work" | "chat"`
  - `evaluateStop(opts: { reportsDir: string; turn: number; kind: TurnKind }): Promise<{ block: boolean; reason: string }>`
  - `ClaudeSession.message(text: string): void` — sends a chat turn
  - `ClaudeSession.turnKind: TurnKind` — getter for the current turn's kind

- [ ] **Step 1: Write the failing tests**

Append to `tests/gates.test.ts`, inside the existing `describe("evaluateStop", ...)` block:

```ts
  it("exempts a chat turn from needing a report", async () => {
    const reportsDir = await makeReports();
    const r = await evaluateStop({ reportsDir, turn: 1, kind: "chat" });
    expect(r.block).toBe(false);
  });

  it("still blocks a work turn with no report", async () => {
    const reportsDir = await makeReports();
    const r = await evaluateStop({ reportsDir, turn: 1, kind: "work" });
    expect(r.block).toBe(true);
  });
```

The four existing `evaluateStop` calls in that file must each gain
`kind: "work"`. They are, in order, in these tests:

| Test | New call |
|---|---|
| blocks when the turn produced no report | `evaluateStop({ reportsDir, turn: 1, kind: "work" })` |
| allows when the turn produced a report | `evaluateStop({ reportsDir, turn: 1, kind: "work" })` |
| blocks when only an older turn's report exists | `evaluateStop({ reportsDir, turn: 2, kind: "work" })` |
| blocks when the directory exists but report.html does not | `evaluateStop({ reportsDir, turn: 1, kind: "work" })` |

Append to `tests/claude-session.test.ts`, inside `describe("ClaudeSession", ...)`:

```ts
  it("marks a started task and an answer as work turns", async () => {
    const session = await makeSession();
    const opts = (session as any).opts;

    session.start("do it");
    await once(session, "turn-end");
    expect(await readFile(join(opts.reportsDir, ".turn-kind"), "utf8")).toBe("work");

    session.answer("chose a");
    await once(session, "turn-end");
    expect(await readFile(join(opts.reportsDir, ".turn-kind"), "utf8")).toBe("work");

    session.stop();
  });

  it("marks a message as a chat turn", async () => {
    const session = await makeSession();
    session.start("do it");
    await once(session, "turn-end");

    session.message("why zod?");
    await once(session, "turn-end");

    const opts = (session as any).opts;
    expect(await readFile(join(opts.reportsDir, ".turn-kind"), "utf8")).toBe("chat");
    expect(session.turnKind).toBe("chat");

    session.stop();
  });

  it("tells a chat turn it does not need a report", async () => {
    const session = await makeSession();
    session.start("do it");
    await once(session, "turn-end");

    const ended = once(session, "turn-end");
    session.message("status?");
    const [result] = await ended;

    expect(result.result).toMatch(/no report/i);
    expect(result.result).toContain("status?");
    session.stop();
  });

  it("refuses to message before it has been started", async () => {
    const session = await makeSession();
    expect(() => session.message("hi")).toThrow(/not started/i);
  });
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm vitest run tests/gates.test.ts tests/claude-session.test.ts`
Expected: FAIL — `evaluateStop` rejects the extra property under strict types, and `session.message` is not a function

- [ ] **Step 3: Add `TurnKind` to `src/shared/types.ts`**

Add at the top of the file, after the imports:

```ts
export type TurnKind = "work" | "chat";
```

- [ ] **Step 4: Update `src/daemon/gates/report-required.ts`**

Replace the whole file:

```ts
import { access } from "node:fs/promises";
import { join } from "node:path";
import type { TurnKind } from "../../shared/types.js";

const REASON =
  "Blocked: you have not written a report for this turn. " +
  "A Specialist may not end a work turn without one. " +
  "Invoke the bench-report skill and write report.html and decision.json " +
  "into the report directory for this turn, then finish.";

/**
 * "Reports at end of work" as a mechanism rather than a request. A chat
 * turn is exempt: the developer asked a question, and answering it in
 * prose is the whole job.
 */
export async function evaluateStop(opts: {
  reportsDir: string;
  turn: number;
  kind: TurnKind;
}): Promise<{ block: boolean; reason: string }> {
  if (opts.kind === "chat") return { block: false, reason: "" };

  const candidate = join(opts.reportsDir, String(opts.turn), "report.html");
  try {
    await access(candidate);
    return { block: false, reason: "" };
  } catch {
    return { block: true, reason: REASON };
  }
}
```

- [ ] **Step 5: Update `src/daemon/hooks/bench-hook.ts`**

Replace the `report-required` branch body with:

```ts
  if (gate === "report-required") {
    const reportsDir = process.env.BENCH_REPORTS_DIR;
    if (!reportsDir) return;

    // The turn marker is written by the daemon before each turn; env cannot
    // carry it because env is fixed when the process spawns.
    let turn = 0;
    try {
      turn = Number(await readFile(join(reportsDir, ".turn"), "utf8"));
    } catch {
      return;
    }
    if (!Number.isInteger(turn) || turn < 1) return;

    // Fail safe: anything other than an explicit "chat" is treated as
    // work, so a missing or corrupt marker can never disable the gate.
    let kind: TurnKind = "work";
    try {
      const raw = (await readFile(join(reportsDir, ".turn-kind"), "utf8")).trim();
      if (raw === "chat") kind = "chat";
    } catch {
      kind = "work";
    }

    const { block, reason } = await evaluateStop({ reportsDir, turn, kind });
    if (!block) return;

    process.stdout.write(JSON.stringify({ decision: "block", reason }));
  }
```

and add to that file's imports:

```ts
import type { TurnKind } from "../../shared/types.js";
```

- [ ] **Step 6: Update `src/daemon/claude-session.ts`**

Add the import:

```ts
import type { TurnKind } from "../shared/types.js";
```

Add a field beside `turnCount`:

```ts
  private currentKind: TurnKind = "work";
```

Add a getter beside `turn`:

```ts
  get turnKind(): TurnKind {
    return this.currentKind;
  }
```

Replace `start`'s last two lines, `answer`, `beginTurn` and `framed` with:

```ts
    this.beginTurn(1, "work");
    this.child.stdin.write(userMessageLine(this.framed(task)));
  }

  answer(text: string): void {
    if (!this.child) throw new Error("session not started");
    this.beginTurn(this.turnCount + 1, "work");
    this.child.stdin.write(userMessageLine(this.framed(text)));
  }

  /**
   * A question, not a work request. Exempt from the report gate. Note that
   * this does not interrupt: if a turn is running, the message queues and
   * is answered once that turn ends.
   */
  message(text: string): void {
    if (!this.child) throw new Error("session not started");
    this.beginTurn(this.turnCount + 1, "chat");
    this.child.stdin.write(userMessageLine(this.framed(text)));
  }

  /**
   * The turn number cannot live in the environment: env is fixed at spawn
   * and a session runs many turns. The gate reads both markers from disk.
   */
  private beginTurn(turn: number, kind: TurnKind): void {
    this.turnCount = turn;
    this.currentKind = kind;
    mkdirSync(this.opts.reportsDir, { recursive: true });
    writeFileSync(join(this.opts.reportsDir, ".turn"), String(turn));
    writeFileSync(join(this.opts.reportsDir, ".turn-kind"), kind);
  }

  private framed(text: string): string {
    if (this.currentKind === "chat") {
      return `[bench] Turn ${this.turnCount}. This is a question, not a work request. ` +
        `Answer in prose. You do not need to write a report for this turn.\n\n${text}`;
    }
    const reportDir = join(this.opts.reportsDir, String(this.turnCount));
    return `[bench] Turn ${this.turnCount}. Write this turn's report into ${reportDir}\n\n${text}`;
  }
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `pnpm vitest run tests/gates.test.ts tests/claude-session.test.ts`
Expected: PASS — 15 gate tests, 11 session tests

- [ ] **Step 8: Verify the gate end to end by hand**

```bash
pnpm build
D=$(mktemp -d); echo 1 > "$D/.turn"; echo chat > "$D/.turn-kind"
echo '{}' | BENCH_REPORTS_DIR="$D" node dist/daemon/hooks/bench-hook.js report-required
echo "[no output above = chat exempted]"
echo work > "$D/.turn-kind"
echo '{}' | BENCH_REPORTS_DIR="$D" node dist/daemon/hooks/bench-hook.js report-required
echo "[JSON block above = work still gated]"
rm "$D/.turn-kind"
echo '{}' | BENCH_REPORTS_DIR="$D" node dist/daemon/hooks/bench-hook.js report-required
echo "[JSON block above = missing kind fails safe]"
```

- [ ] **Step 9: Commit**

```bash
git add src/shared/types.ts src/daemon/gates/report-required.ts src/daemon/hooks/bench-hook.ts src/daemon/claude-session.ts tests/gates.test.ts tests/claude-session.test.ts
git commit -m "Add work and chat turn kinds with a fail-safe report gate"
```

---

### Task 2: Reply text

A chat reply currently arrives nowhere — the codec extracts tool names and throws prose away.

**Files:**
- Modify: `src/daemon/stream-codec.ts`
- Modify: `src/daemon/claude-session.ts`
- Test: `tests/stream-codec.test.ts`, `tests/claude-session.test.ts`

**Interfaces:**
- Consumes: `ResultEvent`, `isResultEvent` (existing)
- Produces:
  - `replyText(event: ClaudeEvent): string | null`
  - `ClaudeSession` emits `reply` with `(text: string, kind: TurnKind)`

- [ ] **Step 1: Write the failing tests**

Append to `tests/stream-codec.test.ts`:

```ts
describe("replyText", () => {
  it("returns the final text of a result event", () => {
    expect(replyText({
      type: "result", subtype: "success", is_error: false,
      session_id: "s1", result: "Because zod validates at the boundary.",
    })).toBe("Because zod validates at the boundary.");
  });

  it("trims surrounding whitespace", () => {
    expect(replyText({
      type: "result", subtype: "success", is_error: false, session_id: "s1",
      result: "  spaced  ",
    })).toBe("spaced");
  });

  it("returns null for an empty result", () => {
    expect(replyText({
      type: "result", subtype: "success", is_error: false, session_id: "s1", result: "   ",
    })).toBeNull();
  });

  it("returns null for a result with no text at all", () => {
    expect(replyText({
      type: "result", subtype: "success", is_error: false, session_id: "s1",
    })).toBeNull();
  });

  it("returns null for events that are not results", () => {
    expect(replyText({ type: "assistant", message: { content: [] } })).toBeNull();
  });
});
```

and add `replyText` to that file's import from `../src/daemon/stream-codec.js`.

Append to `tests/claude-session.test.ts`:

```ts
  it("emits a reply carrying the turn kind", async () => {
    const session = await makeSession();
    const seen: Array<{ text: string; kind: string }> = [];
    session.on("reply", (text: string, kind: string) => seen.push({ text, kind }));

    session.start("do it");
    await once(session, "turn-end");
    expect(seen[0].kind).toBe("work");

    session.message("why?");
    await once(session, "turn-end");
    expect(seen[1].kind).toBe("chat");
    expect(seen[1].text).toContain("why?");

    session.stop();
  });
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm vitest run tests/stream-codec.test.ts tests/claude-session.test.ts`
Expected: FAIL — `replyText` is not exported, and no `reply` event is emitted

- [ ] **Step 3: Add `replyText` to `src/daemon/stream-codec.ts`**

Append to the file:

```ts
/**
 * The turn's final assistant text. Taken from the result event rather than
 * accumulated from streamed blocks: the thread only shows a reply once the
 * turn ends, so streaming buys nothing.
 */
export function replyText(event: ClaudeEvent): string | null {
  if (!isResultEvent(event)) return null;
  const text = event.result?.trim();
  return text ? text : null;
}
```

- [ ] **Step 4: Emit it from `src/daemon/claude-session.ts`**

Add `replyText` to the import from `./stream-codec.js`, then replace the `consume` method:

```ts
  private consume(chunk: string): void {
    for (const event of this.decoder.push(chunk)) {
      const line = activityLine(event);
      if (line) this.emit("activity", line);

      if (isResultEvent(event)) {
        const reply = replyText(event);
        if (reply) this.emit("reply", reply, this.currentKind);
        this.emit("turn-end", event);
      }
    }
  }
```

`reply` is emitted before `turn-end` so a listener that appends to the thread sees the reply before the roster flips to awaiting-decision.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm vitest run tests/stream-codec.test.ts tests/claude-session.test.ts`
Expected: PASS — 14 codec tests, 12 session tests

- [ ] **Step 6: Commit**

```bash
git add src/daemon/stream-codec.ts src/daemon/claude-session.ts tests/stream-codec.test.ts tests/claude-session.test.ts
git commit -m "Capture reply text from the result event"
```

---

### Task 3: The thread store

Append-only, one file per session, so a thread survives a browser refresh and a daemon restart.

**Files:**
- Modify: `src/shared/types.ts`
- Create: `src/daemon/thread.ts`
- Test: `tests/thread.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `ThreadEntryInput = { kind: "user" | "reply" | "report"; body: string; reportSeq?: number }`
  - `ThreadEntry = ThreadEntryInput & { seq: number; at: string }`
  - `appendEntry(threadPath: string, input: ThreadEntryInput): Promise<void>`
  - `readThread(threadPath: string): Promise<ThreadEntry[]>`

- [ ] **Step 1: Write the failing test**

`tests/thread.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
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
    await writeFile(path, (await import("node:fs/promises")).then ? "" : "", { flag: "a" });
    await appendEntry(path, { kind: "user", body: "also good" });

    // Splice a broken line into the middle.
    const fs = await import("node:fs/promises");
    const raw = await fs.readFile(path, "utf8");
    await fs.writeFile(path, raw.replace("\n", "\n{ not json }\n"));

    const entries = await readThread(path);
    expect(entries.map((e) => e.body)).toEqual(["good", "also good"]);
    expect(entries.map((e) => e.seq)).toEqual([1, 2]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run tests/thread.test.ts`
Expected: FAIL — cannot resolve `../src/daemon/thread.js`

- [ ] **Step 3: Add the types to `src/shared/types.ts`**

Append:

```ts
export type ThreadEntryKind = "user" | "reply" | "report";

export interface ThreadEntryInput {
  kind: ThreadEntryKind;
  body: string;
  reportSeq?: number;
}

export interface ThreadEntry extends ThreadEntryInput {
  seq: number;
  at: string;
}
```

- [ ] **Step 4: Write `src/daemon/thread.ts`**

```ts
import { appendFile, readFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { ThreadEntry, ThreadEntryInput } from "../shared/types.js";

/**
 * One JSON object per line. Sequence numbers are assigned at read time
 * from line order, so an append never has to read the file first and two
 * appends can never collide on a number.
 */
export async function appendEntry(threadPath: string, input: ThreadEntryInput): Promise<void> {
  await mkdir(dirname(threadPath), { recursive: true });
  const record = { at: new Date().toISOString(), ...input };
  await appendFile(threadPath, JSON.stringify(record) + "\n", "utf8");
}

export async function readThread(threadPath: string): Promise<ThreadEntry[]> {
  let raw: string;
  try {
    raw = await readFile(threadPath, "utf8");
  } catch {
    // No thread yet, or unreadable. An empty thread is a valid answer.
    return [];
  }

  const entries: ThreadEntry[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    try {
      const parsed = JSON.parse(trimmed) as Omit<ThreadEntry, "seq">;
      entries.push({ ...parsed, seq: entries.length + 1 });
    } catch {
      // A corrupt line loses one entry, never the whole conversation.
    }
  }
  return entries;
}
```

- [ ] **Step 5: Run it to verify it passes**

Run: `pnpm vitest run tests/thread.test.ts`
Expected: PASS, 7 tests

- [ ] **Step 6: Commit**

```bash
git add src/shared/types.ts src/daemon/thread.ts tests/thread.test.ts
git commit -m "Add the append-only thread store"
```

---

### Task 4: Message and thread routes

Chat gets its own route so the turn kind is decided by which endpoint was called, never by inspecting content.

**Files:**
- Modify: `src/daemon/server.ts`
- Modify: `src/daemon/index.ts`
- Test: `tests/server.test.ts`

**Interfaces:**
- Consumes: `appendEntry`, `readThread` (Task 3); `ClaudeSession.message` (Task 1)
- Produces:
  - `SessionRegistryLike.get(id)` now returns `{ reportsDir: string; threadPath: string; alive: boolean } | null`
  - `SessionRegistryLike.message(id: string, text: string): void`
  - `GET /api/sessions/:id/thread` → `{ entries: ThreadEntry[] }`
  - `POST /api/sessions/:id/message` `{ text }` → `{ ok: true }`, or 409 when the session is not alive

- [ ] **Step 1: Write the failing tests**

In `tests/server.test.ts`, replace `StubRegistry`'s `get` and add the new members:

```ts
  threadPathValue = "";
  aliveValue = true;
  messages: Array<{ id: string; text: string }> = [];

  get(id: string) {
    return id === "s1"
      ? { reportsDir: this.reportsDir, threadPath: this.threadPathValue, alive: this.aliveValue }
      : null;
  }
  message(id: string, text: string) { this.messages.push({ id, text }); }
```

In `beforeAll`, after `registry.reportsDir = reportsDir;` add:

```ts
  registry.threadPathValue = join(reportsDir, "thread.jsonl");
  await writeFile(
    registry.threadPathValue,
    JSON.stringify({ at: new Date().toISOString(), kind: "user", body: "hello there" }) + "\n",
  );
```

Append these suites:

```ts
describe("GET /api/sessions/:id/thread", () => {
  it("returns the thread entries", async () => {
    const res = await fetch(`${base}/api/sessions/s1/thread`, auth);
    const body = await res.json();
    expect(body.entries[0].body).toBe("hello there");
    expect(body.entries[0].seq).toBe(1);
  });

  it("404s for an unknown session", async () => {
    const res = await fetch(`${base}/api/sessions/nope/thread`, auth);
    expect(res.status).toBe(404);
  });
});

describe("POST /api/sessions/:id/message", () => {
  it("forwards the message to the registry", async () => {
    const res = await fetch(`${base}/api/sessions/s1/message`, {
      method: "POST",
      headers: { ...auth.headers, "content-type": "application/json" },
      body: JSON.stringify({ text: "why zod?" }),
    });

    expect(res.status).toBe(200);
    expect(registry.messages.at(-1)).toEqual({ id: "s1", text: "why zod?" });
  });

  it("400s on an empty message", async () => {
    const res = await fetch(`${base}/api/sessions/s1/message`, {
      method: "POST",
      headers: { ...auth.headers, "content-type": "application/json" },
      body: JSON.stringify({ text: "   " }),
    });
    expect(res.status).toBe(400);
  });

  it("409s when the session process is no longer alive", async () => {
    registry.aliveValue = false;
    const res = await fetch(`${base}/api/sessions/s1/message`, {
      method: "POST",
      headers: { ...auth.headers, "content-type": "application/json" },
      body: JSON.stringify({ text: "anyone there?" }),
    });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/not running/i);
    registry.aliveValue = true;
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm vitest run tests/server.test.ts`
Expected: FAIL — 404 on `/thread` and `/message`

- [ ] **Step 3: Update `src/daemon/server.ts`**

Change the interface:

```ts
export interface SessionRegistryLike {
  list(): RosterRow[];
  get(id: string): { reportsDir: string; threadPath: string; alive: boolean } | null;
  answer(id: string, text: string): void;
  message(id: string, text: string): void;
  stop(id: string): void;
  create(input: { project: string; label: string; task: string; model: string }): Promise<string>;
  on(event: "roster", listener: () => void): unknown;
}
```

Add to the imports:

```ts
import { readThread } from "./thread.js";
```

Add these two branches immediately before the `/answer` branch:

```ts
    const thread = path.match(/^\/api\/sessions\/([^/]+)\/thread$/);
    if (thread && req.method === "GET") {
      const session = registry.get(thread[1]);
      if (!session) { json(res, 404, { error: "no such session" }); return; }
      json(res, 200, { entries: await readThread(session.threadPath) });
      return;
    }

    const message = path.match(/^\/api\/sessions\/([^/]+)\/message$/);
    if (message && req.method === "POST") {
      const session = registry.get(message[1]);
      if (!session) { json(res, 404, { error: "no such session" }); return; }

      const body = await readBody(req);
      const text = String(body.text ?? "").trim();
      if (text === "") { json(res, 400, { error: "text is required" }); return; }

      // A dead process cannot be queued into, and silently accepting the
      // message would strand it forever.
      if (!session.alive) { json(res, 409, { error: "session is not running" }); return; }

      registry.message(message[1], text);
      json(res, 200, { ok: true });
      return;
    }
```

- [ ] **Step 4: Update `src/daemon/index.ts`**

Add the imports:

```ts
import { appendEntry } from "./thread.js";
import type { TurnKind } from "../shared/types.js";
```

Add `threadPath` and `alive` to `Entry`:

```ts
interface Entry {
  row: RosterRow;
  reportsDir: string;
  threadPath: string;
  session: ClaudeSession | null;
  alive: boolean;
}
```

Replace `get`:

```ts
  get(id: string): { reportsDir: string; threadPath: string; alive: boolean } | null {
    const entry = this.entries.get(id);
    return entry
      ? { reportsDir: entry.reportsDir, threadPath: entry.threadPath, alive: entry.alive }
      : null;
  }
```

In `create`, set the new fields when the entry is registered — replace the `this.entries.set(id, {...})` call with:

```ts
    this.entries.set(id, {
      reportsDir,
      threadPath: join(reportsDir, "thread.jsonl"),
      session: null,
      alive: false,
      row: {
        id,
        label: input.label,
        project: input.project,
        status: "provisioning",
        detail: "creating worktree",
        latestReportSeq: null,
      },
    });
```

Replace the three `session.on(...)` handlers with:

```ts
      session.on("activity", (line: string) => this.update(id, "working", line));
      session.on("exit", () => {
        const entry = this.entries.get(id);
        if (entry) entry.alive = false;
        this.update(id, "crashed", "process exited");
      });

      session.on("reply", async (text: string, kind: TurnKind) => {
        // A work turn's prose is not shown - its report card is the entry.
        if (kind !== "chat") return;
        await appendEntry(join(reportsDir, "thread.jsonl"), { kind: "reply", body: text });
        this.emit("roster");
      });

      session.on("turn-end", async () => {
        const entry = this.entries.get(id);
        if (!entry) return;

        const seq = await latestReportSeq(reportsDir);
        const isNewReport = seq !== null && seq !== entry.row.latestReportSeq;
        entry.row.latestReportSeq = seq;

        if (isNewReport) {
          const report = await findReport(reportsDir, seq);
          await appendEntry(entry.threadPath, {
            kind: "report",
            body: report ? report.decision.title : `Report ${seq}`,
            reportSeq: seq,
          });
        }

        this.update(id, "awaiting_decision", "waiting on you");
      });
```

Add `findReport` to the existing import from `./reports.js`:

```ts
import { latestReportSeq, findReport } from "./reports.js";
```

Mark the session alive right after `session.start(...)`:

```ts
      this.entries.get(id)!.session = session;
      this.entries.get(id)!.alive = true;
      session.start(input.task);
      this.update(id, "working", "starting");
```

Replace `answer` and add `message`:

```ts
  answer(id: string, text: string): void {
    const entry = this.entries.get(id);
    if (!entry?.session) return;
    void appendEntry(entry.threadPath, { kind: "user", body: text });
    entry.session.answer(text);
    this.update(id, "working", "resumed");
  }

  message(id: string, text: string): void {
    const entry = this.entries.get(id);
    if (!entry?.session) return;
    void appendEntry(entry.threadPath, { kind: "user", body: text });
    entry.session.message(text);
    this.update(id, "working", "answering your question");
  }
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm vitest run tests/server.test.ts && pnpm typecheck`
Expected: PASS — 19 server tests, no type errors

- [ ] **Step 6: Commit**

```bash
git add src/daemon/server.ts src/daemon/index.ts tests/server.test.ts
git commit -m "Add message and thread routes wired to the thread store"
```

---

### Task 5: The cockpit

Three parts: a roster carrying all in-flight visibility, a quiet thread, and one composer that becomes the decision when a report lands.

**Files:**
- Modify: `src/client/index.html`
- Modify: `src/client/styles.css`
- Modify: `src/client/app.js`

**Interfaces:**
- Consumes: `GET /api/roster`, `GET /api/sessions/:id/thread`, `GET /api/sessions/:id/report/:seq`, `GET /r/:id/:seq/report.html`, `POST /api/sessions/:id/message`, `POST /api/sessions/:id/answer`, `POST /api/sessions`, `WS /events`
- Produces: nothing consumed by later tasks

- [ ] **Step 1: Replace `src/client/index.html`**

```html
<main id="app">
  <aside id="roster">
    <header>
      <h1>Bench</h1>
      <button id="new-session" type="button">New</button>
    </header>
    <ul id="roster-list"></ul>
  </aside>

  <section id="stage">
    <header id="stage-head" hidden>
      <span id="stage-label"></span>
      <span id="stage-status"></span>
    </header>

    <div id="thread">
      <p id="empty">Select a specialist.</p>
    </div>

    <footer id="composer">
      <div id="decision" hidden>
        <div id="decision-head">
          <strong id="decision-title"></strong>
          <span id="decision-summary"></span>
        </div>
        <div id="decision-options"></div>
      </div>
      <form id="composer-form">
        <input id="composer-text" type="text" autocomplete="off"
               placeholder="Message this specialist" disabled />
      </form>
      <p id="composer-hint"></p>
    </footer>
  </section>
</main>
<link rel="stylesheet" href="/styles.css" />
<script type="module" src="/app.js"></script>
```

- [ ] **Step 2: Replace `src/client/styles.css`**

```css
:root {
  --bg: #0c1210;
  --panel: #111a16;
  --raised: #16211c;
  --line: #ffffff14;
  --hover: #ffffff0d;
  --text: #e8efe9;
  --muted: #8ba396;
  --accent: #4fd18b;
  --accent-dim: #2b6b4c;
  --danger: #e0685c;
  --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}

* { box-sizing: border-box; }

body {
  margin: 0;
  background: var(--bg);
  color: var(--text);
  font: 14px/1.6 ui-sans-serif, system-ui, sans-serif;
}

button, input { font: inherit; color: inherit; }

#app { display: grid; grid-template-columns: 264px 1fr; height: 100vh; }

/* Roster carries all in-flight visibility, since the thread carries none. */
#roster {
  background: var(--panel);
  border-right: 1px solid var(--line);
  display: flex;
  flex-direction: column;
  overflow-y: auto;
}

#roster header {
  display: flex; align-items: center; justify-content: space-between;
  padding: 18px 16px; border-bottom: 1px solid var(--line);
}

#roster h1 { margin: 0; font-size: 14px; font-weight: 600; letter-spacing: 0.04em; }

#new-session {
  background: transparent; border: 1px solid var(--line);
  border-radius: 6px; padding: 4px 10px; color: var(--muted); cursor: pointer;
}
#new-session:hover { background: var(--hover); color: var(--text); }

#roster-list { list-style: none; margin: 0; padding: 0; }

/* Specialists are grouped by project - never a flat list. */
.group > summary {
  position: sticky; top: 0; z-index: 1;
  background: var(--panel); border-bottom: 1px solid var(--line);
  padding: 10px 16px; cursor: pointer; list-style: none;
  display: flex; align-items: center; gap: 8px;
  font-family: var(--mono); font-size: 11px;
  letter-spacing: 0.08em; text-transform: uppercase; color: var(--muted);
}
.group > summary::-webkit-details-marker { display: none; }
.group > summary:hover { background: var(--hover); }
.group .count { margin-left: auto; }

/* A collapsed project still shows that something inside it needs you. */
.group .waiting { width: 6px; height: 6px; border-radius: 50%; background: var(--accent); }
.group[open] .waiting { display: none; }

.row {
  padding: 12px 16px; border-bottom: 1px solid var(--line);
  cursor: pointer; border-left: 2px solid transparent;
}
.row:hover { background: var(--hover); }
.row[aria-selected="true"] { background: var(--bg); border-left-color: var(--accent-dim); }

.row .label { font-weight: 600; }
.row .detail {
  color: var(--muted); font-size: 12px; font-family: var(--mono);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.row .state {
  font-size: 11px; letter-spacing: 0.08em; text-transform: uppercase;
  color: var(--muted); font-family: var(--mono);
}

/* Accent is reserved for the one thing that needs action. */
.row[data-status="awaiting_decision"] .state { color: var(--accent); font-weight: 700; }
.row[data-status="awaiting_decision"] { border-left-color: var(--accent); }
.row[data-status="crashed"] .state,
.row[data-status="provisioning_failed"] .state { color: var(--danger); }

#stage { display: flex; flex-direction: column; min-width: 0; }

#stage-head {
  display: flex; align-items: baseline; gap: 12px;
  padding: 14px 24px; border-bottom: 1px solid var(--line);
}
#stage-label { font-weight: 600; }
#stage-status { color: var(--muted); font-size: 12px; font-family: var(--mono); }

#thread { flex: 1; overflow-y: auto; padding: 24px; }
#empty { color: var(--muted); margin: 0; }

.entry { max-width: 760px; margin: 0 0 18px; }
.entry.user { margin-left: auto; }

.entry .who {
  font-size: 11px; letter-spacing: 0.08em; text-transform: uppercase;
  color: var(--muted); font-family: var(--mono); margin-bottom: 6px;
}

.bubble {
  background: var(--raised); border: 1px solid var(--line);
  border-radius: 10px; padding: 12px 14px; white-space: pre-wrap;
}
.entry.user .bubble { background: var(--panel); }

.card {
  background: var(--raised); border: 1px solid var(--line);
  border-radius: 10px; overflow: hidden;
}
.card > summary {
  padding: 12px 14px; cursor: pointer; list-style: none;
  display: flex; align-items: baseline; gap: 10px;
}
.card > summary::-webkit-details-marker { display: none; }
.card .kind {
  font-size: 11px; letter-spacing: 0.08em; text-transform: uppercase;
  color: var(--muted); font-family: var(--mono);
}
.card .title { font-weight: 600; }
.card iframe { width: 100%; height: 60vh; border: 0; border-top: 1px solid var(--line); background: var(--bg); }

#composer { border-top: 1px solid var(--line); background: var(--panel); padding: 14px 24px; }

#decision { margin-bottom: 12px; }
#decision-head { margin-bottom: 10px; }
#decision-title { color: var(--accent); }
#decision-summary { color: var(--muted); margin-left: 10px; }
#decision-options { display: flex; flex-wrap: wrap; gap: 8px; }

.option {
  background: var(--raised); border: 1px solid var(--line);
  border-radius: 8px; padding: 8px 12px; cursor: pointer; text-align: left;
}
.option:hover { background: var(--hover); }
.option[aria-pressed="true"] { border-color: var(--accent); }
.option .key { color: var(--muted); font-family: var(--mono); margin-right: 8px; }
.option .hint { display: block; color: var(--muted); font-size: 12px; margin-top: 2px; }

#composer-text {
  width: 100%; background: var(--raised); border: 1px solid var(--line);
  border-radius: 8px; padding: 10px 12px;
}
#composer-text:focus { outline: none; border-color: var(--accent-dim); }
#composer-text:disabled { opacity: 0.5; cursor: not-allowed; }

#composer-hint {
  margin: 8px 0 0; font-size: 12px; color: var(--muted); font-family: var(--mono);
  min-height: 1.4em;
}
```

- [ ] **Step 3: Replace `src/client/app.js`**

```js
const token = new URLSearchParams(location.search).get("token") ?? "";
const authHeaders = { "x-bench-token": token };

const state = { rows: [], selectedId: null, entries: [], decision: null, choice: null };

const el = {
  list: document.getElementById("roster-list"),
  head: document.getElementById("stage-head"),
  headLabel: document.getElementById("stage-label"),
  headStatus: document.getElementById("stage-status"),
  thread: document.getElementById("thread"),
  decision: document.getElementById("decision"),
  title: document.getElementById("decision-title"),
  summary: document.getElementById("decision-summary"),
  options: document.getElementById("decision-options"),
  form: document.getElementById("composer-form"),
  text: document.getElementById("composer-text"),
  hint: document.getElementById("composer-hint"),
  newSession: document.getElementById("new-session"),
};

const api = (path, init) => fetch(path, { ...init, headers: { ...authHeaders, ...(init?.headers ?? {}) } });
const selectedRow = () => state.rows.find((r) => r.id === state.selectedId) ?? null;

const collapsed = new Set();

function rosterRow(row) {
  const li = document.createElement("li");
  li.className = "row";
  li.dataset.status = row.status;
  li.setAttribute("aria-selected", String(row.id === state.selectedId));
  li.onclick = () => select(row.id);

  const label = document.createElement("div");
  label.className = "label";
  label.textContent = row.label;

  const state_ = document.createElement("div");
  state_.className = "state";
  state_.textContent = row.status.replace(/_/g, " ");

  const detail = document.createElement("div");
  detail.className = "detail";
  detail.textContent = row.detail;

  li.append(label, state_, detail);
  return li;
}

/**
 * Grouped by project, never flat. Working across many repos at once, a flat
 * list gives no way to tell which specialist belongs to which codebase.
 */
function renderRoster() {
  const groups = new Map();
  for (const row of state.rows) {
    if (!groups.has(row.project)) groups.set(row.project, []);
    groups.get(row.project).push(row);
  }

  el.list.replaceChildren(...[...groups.entries()].map(([project, rows]) => {
    const group = document.createElement("details");
    group.className = "group";
    group.open = !collapsed.has(project);
    group.ontoggle = () => {
      if (group.open) collapsed.delete(project); else collapsed.add(project);
    };

    const summary = document.createElement("summary");
    summary.title = project;

    const name = document.createElement("span");
    name.textContent = project.split("/").filter(Boolean).pop() ?? project;
    summary.append(name);

    // Collapsing must never hide a specialist that needs an answer.
    if (rows.some((r) => r.status === "awaiting_decision")) {
      const dot = document.createElement("span");
      dot.className = "waiting";
      dot.title = "a specialist here is waiting on you";
      summary.append(dot);
    }

    const count = document.createElement("span");
    count.className = "count";
    count.textContent = String(rows.length);
    summary.append(count);

    const list = document.createElement("ul");
    list.style.listStyle = "none";
    list.style.margin = "0";
    list.style.padding = "0";
    list.append(...rows.map(rosterRow));

    group.append(summary, list);
    return group;
  }));
}

function reportCard(entry) {
  const card = document.createElement("details");
  card.className = "card";

  const summary = document.createElement("summary");
  const kind = document.createElement("span");
  kind.className = "kind";
  kind.textContent = "report";
  const title = document.createElement("span");
  title.className = "title";
  title.textContent = entry.body;
  summary.append(kind, title);

  const frame = document.createElement("iframe");
  frame.setAttribute("sandbox", "allow-same-origin");
  frame.title = entry.body;

  // Only load the report body once the card is actually opened.
  card.ontoggle = () => {
    if (card.open && !frame.src) {
      frame.src = `/r/${state.selectedId}/${entry.reportSeq}/report.html?token=${encodeURIComponent(token)}`;
    }
  };

  card.append(summary, frame);
  return card;
}

function renderThread() {
  if (!state.selectedId) {
    const empty = document.createElement("p");
    empty.id = "empty";
    empty.textContent = "Select a specialist.";
    el.thread.replaceChildren(empty);
    return;
  }

  if (state.entries.length === 0) {
    const empty = document.createElement("p");
    empty.id = "empty";
    empty.textContent = "No messages yet.";
    el.thread.replaceChildren(empty);
    return;
  }

  el.thread.replaceChildren(...state.entries.map((entry) => {
    const wrap = document.createElement("div");
    wrap.className = `entry ${entry.kind}`;

    const who = document.createElement("div");
    who.className = "who";
    who.textContent = entry.kind === "user" ? "you" : entry.kind === "reply" ? "specialist" : "";
    if (who.textContent) wrap.append(who);

    if (entry.kind === "report") {
      wrap.append(reportCard(entry));
    } else {
      const bubble = document.createElement("div");
      bubble.className = "bubble";
      bubble.textContent = entry.body;
      wrap.append(bubble);
    }
    return wrap;
  }));

  el.thread.scrollTop = el.thread.scrollHeight;
}

function renderComposer() {
  const row = selectedRow();
  el.text.disabled = !row;

  if (!state.decision) {
    el.decision.hidden = true;
    el.text.placeholder = "Message this specialist";
    el.hint.textContent = row && row.status === "working"
      ? "Working. A message queues and is answered when the current turn ends."
      : "";
    return;
  }

  el.decision.hidden = false;
  el.title.textContent = state.decision.title;
  el.summary.textContent = state.decision.summary;
  el.text.placeholder = "Or type an answer";
  el.hint.textContent = state.decision.options.length
    ? "Number keys pick, Enter confirms."
    : "Enter sends.";

  el.options.replaceChildren(...state.decision.options.map((option, index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "option";
    button.setAttribute("aria-pressed", String(state.choice === option.id));
    button.onclick = () => { state.choice = option.id; renderComposer(); };

    const key = document.createElement("span");
    key.className = "key";
    key.textContent = String(index + 1);
    button.append(key, document.createTextNode(option.label));

    if (option.hint) {
      const hint = document.createElement("span");
      hint.className = "hint";
      hint.textContent = option.hint;
      button.append(hint);
    }
    return button;
  }));
}

function renderHead() {
  const row = selectedRow();
  el.head.hidden = !row;
  if (!row) return;
  el.headLabel.textContent = row.label;
  el.headStatus.textContent = `${row.status.replace(/_/g, " ")} · ${row.detail}`;
}

async function loadDecision(row) {
  if (!row || row.status !== "awaiting_decision" || row.latestReportSeq === null) {
    state.decision = null;
    return;
  }
  const res = await api(`/api/sessions/${row.id}/report/${row.latestReportSeq}`);
  state.decision = res.ok ? (await res.json()).decision : null;
  state.choice = null;
}

async function refreshThread() {
  if (!state.selectedId) { state.entries = []; return; }
  const res = await api(`/api/sessions/${state.selectedId}/thread`);
  state.entries = res.ok ? (await res.json()).entries : [];
}

async function select(id) {
  state.selectedId = id;
  await refreshThread();
  await loadDecision(selectedRow());
  renderRoster(); renderHead(); renderThread(); renderComposer();
}

async function submit() {
  const row = selectedRow();
  if (!row) return;
  const text = el.text.value.trim();

  if (state.decision) {
    if (!state.choice && text === "") return;
    await api(`/api/sessions/${row.id}/answer`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ optionId: state.choice, text }),
    });
    state.decision = null;
    state.choice = null;
  } else {
    if (text === "") return;
    const res = await api(`/api/sessions/${row.id}/message`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
    });
    if (!res.ok) {
      el.hint.textContent = (await res.json()).error ?? "could not send";
      return;
    }
  }

  el.text.value = "";
  await refreshThread();
  renderThread();
  renderComposer();
}

el.form.onsubmit = (event) => { event.preventDefault(); submit(); };

document.addEventListener("keydown", (event) => {
  if (event.target === el.text) return;
  if (!state.decision) return;

  const index = Number(event.key) - 1;
  const options = state.decision.options;
  if (Number.isInteger(index) && index >= 0 && index < options.length) {
    state.choice = options[index].id;
    renderComposer();
    return;
  }
  if (event.key === "Enter") { event.preventDefault(); submit(); }
  if (event.key === "/") { event.preventDefault(); el.text.focus(); }
});

el.newSession.onclick = async () => {
  const project = prompt("Project path (inside WSL)", "/var/www/teledoctor");
  if (!project) return;
  const label = prompt("Label (lowercase, hyphens)", "task-one");
  if (!label) return;
  const task = prompt("What should the specialist do?");
  if (!task) return;

  await api("/api/sessions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ project, label, task, model: "opus" }),
  });
};

function connect() {
  const socket = new WebSocket(`ws://${location.host}/events?token=${encodeURIComponent(token)}`);

  socket.onmessage = async (event) => {
    const message = JSON.parse(event.data);
    if (message.type !== "roster") return;

    state.rows = message.rows;
    renderRoster();
    renderHead();

    if (!state.selectedId) return;
    await refreshThread();
    await loadDecision(selectedRow());
    renderThread();
    renderComposer();
  };

  // The daemon outlives the UI, so a dropped socket is a reconnect.
  socket.onclose = () => setTimeout(connect, 1000);
}

renderComposer();
connect();
```

- [ ] **Step 4: Build and check it serves**

```bash
pnpm build
BENCH_PORT=7433 node dist/daemon/index.js &
sleep 2
curl -s -o /dev/null -w "shell %{http_code}\n" http://127.0.0.1:7433/
curl -s -o /dev/null -w "app.js %{http_code}\n" http://127.0.0.1:7433/app.js
curl -s -o /dev/null -w "styles %{http_code}\n" http://127.0.0.1:7433/styles.css
kill %1
```

Expected: three 200s.

- [ ] **Step 5: Look at it**

Open the printed URL in a browser. Confirm: dark green ground, roster on the left, empty thread, composer disabled with no specialist selected. Nothing should be accent-coloured on an idle screen — if anything is, the accent rule is being broken.

- [ ] **Step 6: Commit**

```bash
git add src/client
git commit -m "Rebuild the cockpit as a conversation"
```

---

### Task 6: End to end

Proves the whole point: a chat turn answers in prose without writing a report, and a work turn still cannot finish without one.

**Files:**
- Create: `tests/e2e-chat.test.ts`

**Interfaces:**
- Consumes: everything
- Produces: nothing

- [ ] **Step 1: Write the test**

`tests/e2e-chat.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ClaudeSession } from "../src/daemon/claude-session.js";
import { latestReportSeq } from "../src/daemon/reports.js";

const exec = promisify(execFile);
const run = process.env.BENCH_E2E === "1" ? describe : describe.skip;

const CHEAP_MODEL = "claude-haiku-4-5-20251001";

run("chat turns against the real claude CLI", () => {
  it("answers a question in prose without writing a report", async () => {
    const worktree = await mkdtemp(join(tmpdir(), "bench-chat-"));
    await exec("git", ["init", "-q", "-b", "main"], { cwd: worktree });

    const reportsDir = join(worktree, ".bench", "reports", "chat");
    await mkdir(reportsDir, { recursive: true });

    const session = new ClaudeSession({
      id: crypto.randomUUID(),
      label: "chat",
      worktree,
      reportsDir,
      hookCommand: `node ${join(process.cwd(), "dist", "daemon", "hooks", "bench-hook.js")}`,
      pluginDir: join(process.cwd(), "plugin"),
      model: CHEAP_MODEL,
      port: 3197,
    });

    // A work turn: the gate forces a report even though none was asked for.
    session.start("Reply with the single word: ready.");
    await once(session, "turn-end");
    expect(await latestReportSeq(reportsDir)).toBe(1);

    // A chat turn: no report may be required of it.
    const replies: string[] = [];
    session.on("reply", (text: string, kind: string) => {
      if (kind === "chat") replies.push(text);
    });

    session.message("In one short sentence, what directory are you working in?");
    await once(session, "turn-end");

    expect(replies).toHaveLength(1);
    expect(replies[0].length).toBeGreaterThan(0);

    // Turn 2 must not have produced a report directory.
    const dirs = await readdir(reportsDir);
    expect(dirs).not.toContain("2");
    expect(await latestReportSeq(reportsDir)).toBe(1);

    session.stop();
  }, 300_000);
});
```

- [ ] **Step 2: Build and run it**

Run: `pnpm build && BENCH_E2E=1 pnpm vitest run tests/e2e-chat.test.ts`
Expected: PASS, 1 test

- [ ] **Step 3: Run the whole suite**

Run: `pnpm vitest run && pnpm typecheck`
Expected: all unit tests pass, no type errors

- [ ] **Step 4: Commit**

```bash
git add tests/e2e-chat.test.ts
git commit -m "Add end-to-end coverage for chat turns"
```

---

## Manual verification

The point of this work is the experience, and only a real session shows whether it landed.

1. `pnpm build && pnpm start`, open the printed URL.
2. Create a specialist against a real project with a small task.
3. While it is working, send it a message. Confirm the hint says the message will queue, and that the reply arrives after the current turn ends rather than immediately.
4. When a report lands, confirm the composer becomes the decision, number keys select, and `Enter` sends.
5. Expand the report card and confirm the report renders inside it.
6. Refresh the browser. The thread must come back intact.
7. Confirm the only accent-coloured thing on screen is the specialist awaiting you.
8. Create a second specialist in a different project. Confirm the roster groups them under separate project headings, that collapsing a group still shows its accent dot when something inside is waiting, and that the collapse survives roster updates.
