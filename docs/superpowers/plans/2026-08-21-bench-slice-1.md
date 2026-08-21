# Bench Slice 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run one Claude Code Specialist in its own git worktree inside WSL, and let the developer read its report and answer it with a keystroke from a browser on localhost.

**Architecture:** A TypeScript daemon (`benchd`) runs inside WSL and owns everything Linux-shaped: it creates and bootstraps a git worktree, spawns `claude` as a long-lived bidirectional stream-json process, enforces gates through hook scripts it injects via `--settings`, watches for report directories, and serves both the report content and the cockpit UI over `127.0.0.1:7420`. The browser is a pure client — it never learns a filesystem path.

**Tech Stack:** Node 22, pnpm 10, TypeScript (strict), `ws` for WebSocket, `zod` for the decision schema, `vitest` for tests. No frontend framework — the client is one HTML file, one stylesheet, one script.

**Spec:** `docs/superpowers/specs/2026-08-21-bench-design.md`

## Global Constraints

- **Node 22, pnpm 10.** Installed in WSL: Node `v22.13.1`, pnpm `10.24.0`.
- **`claude` CLI `>= 2.1.238`.** Every flag and wire format in this plan was verified against `2.1.238`.
- **`--verbose` is mandatory.** `claude -p --output-format stream-json` exits immediately with `Error: When using --print, --output-format=stream-json requires --verbose`. Every spawn includes it.
- **Linux paths only.** Never construct, accept, store, or return a Windows or UNC path (`\\wsl.localhost\...`, `C:\...`). The client submits one path — the project root the developer types when creating a specialist — and it is validated as an absolute POSIX path before use. Worktree paths and report paths are never sent to the client; it addresses those by session id and sequence number.
- **No Claude or Anthropic attribution** in any commit message, code comment, or PR in this repo. This is a global rule and Bench itself enforces it on the agents it runs.
- **TypeScript strict mode.** `"strict": true` in `tsconfig.json`.
- **Small focused files.** Business logic lives in its own module, not in the server file. Shared types live in `src/shared/types.ts`. No file grows past a single responsibility.
- **Default port 7420**, overridable with `BENCH_PORT`. Config root `~/.bench`, overridable with `BENCH_HOME`.

## Deferred from the spec

The spec's **two-phase permission mode** — a Specialist starting in
`--permission-mode plan` and being resumed into `acceptEdits` on approval —
is **not** in Slice 1. Changing permission mode requires killing and
resuming the process, and resume is out of scope for this slice. Slice 1
runs every session in `acceptEdits` for its whole life. The report gate
still fires, so a Specialist still cannot finish without reporting; what is
missing is the guarantee that it could not edit before you approved a spec.
This is the first thing Slice 2 should restore.

## File Structure

```
package.json                        deps, scripts
tsconfig.json                       strict TS, NodeNext
vitest.config.ts                    test config

src/shared/types.ts                 SessionStatus, RosterRow, decision zod schema
src/daemon/stream-codec.ts          NDJSON framing, event typing, input serialisation
src/daemon/worktree.ts              git worktree creation, .bench exclusion
src/daemon/bootstrap.ts             making a worktree runnable (install, env, prisma, port)
src/daemon/gates/commit-attribution.ts   pure matcher: does this git commit carry attribution
src/daemon/gates/report-required.ts      pure check: did this turn produce a report
src/daemon/gates/settings.ts        builds the --settings JSON injected per session
src/daemon/hooks/bench-hook.ts      CLI entrypoint that Claude Code hooks invoke
src/daemon/claude-session.ts        process lifecycle, turn lifecycle, answer injection
src/daemon/reports.ts               report discovery, decision.json parsing and degradation
src/daemon/config.ts                paths, port, auth token
src/daemon/server.ts                HTTP routes + WebSocket roster feed
src/daemon/index.ts                 entrypoint: wires config, server, session registry

plugin/.claude-plugin/plugin.json   Bench plugin manifest
plugin/skills/bench-report/SKILL.md the report contract, delivered to Specialists

src/client/index.html               cockpit shell
src/client/app.js                   roster, report frame, decision bar, keyboard
src/client/styles.css               layout and theme

tests/helpers/scratch-repo.ts       throwaway git repo fixture
tests/*.test.ts                     one per module
```

---

### Task 1: Scaffolding and the stream-json codec

The codec is the foundation — every other task consumes its types. It handles NDJSON framing (events arrive split across arbitrary chunk boundaries) and identifies turn ends.

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`
- Create: `src/shared/types.ts`
- Create: `src/daemon/stream-codec.ts`
- Test: `tests/stream-codec.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `LineDecoder` (class, method `push(chunk: string): ClaudeEvent[]`), `userMessageLine(text: string): string`, `isResultEvent(e: ClaudeEvent): e is ResultEvent`, `activityLine(e: ClaudeEvent): string | null`, and from types: `SessionStatus`, `RosterRow`, `decisionSchema`, `Decision`

- [ ] **Step 1: Create the project files**

`package.json`:

```json
{
  "name": "bench",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "engines": { "node": ">=22" },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "dev": "tsx watch src/daemon/index.ts",
    "start": "node dist/daemon/index.js",
    "test": "vitest run",
    "typecheck": "tsc -p tsconfig.json --noEmit"
  },
  "dependencies": {
    "ws": "^8.18.0",
    "zod": "^3.23.8"
  },
  "devDependencies": {
    "@types/node": "^22.10.0",
    "@types/ws": "^8.5.13",
    "tsx": "^4.19.2",
    "typescript": "^5.7.2",
    "vitest": "^2.1.8"
  }
}
```

`tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "outDir": "dist",
    "rootDir": "src",
    "skipLibCheck": true,
    "esModuleInterop": true,
    "resolveJsonModule": true
  },
  "include": ["src/**/*.ts"]
}
```

`vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    testTimeout: 30_000,
  },
});
```

Then run: `pnpm install`

- [ ] **Step 2: Write the failing test**

`tests/stream-codec.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  LineDecoder,
  userMessageLine,
  isResultEvent,
  activityLine,
} from "../src/daemon/stream-codec.js";

describe("LineDecoder", () => {
  it("emits one event per complete line", () => {
    const d = new LineDecoder();
    const events = d.push('{"type":"system","subtype":"init"}\n');
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("system");
  });

  it("reassembles an event split across chunks", () => {
    const d = new LineDecoder();
    expect(d.push('{"type":"resu')).toHaveLength(0);
    const events = d.push('lt","subtype":"success","is_error":false,"session_id":"s1"}\n');
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("result");
  });

  it("skips blank lines and unparseable lines without throwing", () => {
    const d = new LineDecoder();
    const events = d.push('\n{ not json }\n{"type":"system","subtype":"init"}\n');
    expect(events).toHaveLength(1);
  });

  it("holds a trailing partial line until it completes", () => {
    const d = new LineDecoder();
    d.push('{"type":"system","subtype":"init"}\n{"type":"assis');
    const events = d.push('tant","message":{"content":[]}}\n');
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("assistant");
  });
});

describe("isResultEvent", () => {
  it("recognises the turn-end event", () => {
    expect(isResultEvent({ type: "result", subtype: "success", is_error: false, session_id: "s1" })).toBe(true);
  });

  it("does not treat an assistant message as a turn end", () => {
    expect(isResultEvent({ type: "assistant", message: { content: [] } })).toBe(false);
  });
});

describe("userMessageLine", () => {
  it("produces a single newline-terminated stream-json user message", () => {
    const line = userMessageLine("hello");
    expect(line.endsWith("\n")).toBe(true);
    expect(JSON.parse(line.trim())).toEqual({
      type: "user",
      message: { role: "user", content: "hello" },
    });
  });
});

describe("activityLine", () => {
  it("describes a tool call for the roster", () => {
    const line = activityLine({
      type: "assistant",
      message: { content: [{ type: "tool_use", name: "Bash" }] },
    });
    expect(line).toBe("Bash");
  });

  it("returns null for events with nothing worth showing", () => {
    expect(activityLine({ type: "system", subtype: "thinking_tokens" })).toBeNull();
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm vitest run tests/stream-codec.test.ts`
Expected: FAIL — cannot resolve `../src/daemon/stream-codec.js`

- [ ] **Step 4: Write `src/shared/types.ts`**

```ts
import { z } from "zod";

export type SessionStatus =
  | "provisioning"
  | "provisioning_failed"
  | "working"
  | "awaiting_decision"
  | "crashed"
  | "done";

export interface RosterRow {
  id: string;
  label: string;
  project: string;
  status: SessionStatus;
  detail: string;
  latestReportSeq: number | null;
}

export const decisionOptionSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  hint: z.string().optional(),
});

export const decisionSchema = z.object({
  kind: z.enum(["spec_approval", "question", "completion"]),
  title: z.string().min(1),
  summary: z.string().min(1),
  options: z.array(decisionOptionSchema).default([]),
  allowFreeText: z.boolean().default(true),
});

export type DecisionOption = z.infer<typeof decisionOptionSchema>;
export type Decision = z.infer<typeof decisionSchema>;
```

- [ ] **Step 5: Write `src/daemon/stream-codec.ts`**

The event shapes below were captured from a live `claude 2.1.238` run, not inferred.

```ts
export interface ResultEvent {
  type: "result";
  subtype: string;
  is_error: boolean;
  session_id: string;
  result?: string;
  total_cost_usd?: number;
  permission_denials?: unknown[];
}

export interface AssistantEvent {
  type: "assistant";
  message: { content: Array<{ type: string; text?: string; name?: string }> };
}

export interface GenericEvent {
  type: string;
  subtype?: string;
  [key: string]: unknown;
}

export type ClaudeEvent = ResultEvent | AssistantEvent | GenericEvent;

/**
 * Claude writes newline-delimited JSON, but a chunk from the pipe can split a
 * line anywhere. The decoder buffers the tail until its newline arrives.
 */
export class LineDecoder {
  private carry = "";

  push(chunk: string): ClaudeEvent[] {
    this.carry += chunk;
    const lines = this.carry.split("\n");
    this.carry = lines.pop() ?? "";

    const events: ClaudeEvent[] = [];
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed === "") continue;
      try {
        events.push(JSON.parse(trimmed) as ClaudeEvent);
      } catch {
        // A malformed line is a diagnostic, never a crash. Drop it.
      }
    }
    return events;
  }
}

export function isResultEvent(event: ClaudeEvent): event is ResultEvent {
  return event.type === "result";
}

export function userMessageLine(text: string): string {
  return JSON.stringify({ type: "user", message: { role: "user", content: text } }) + "\n";
}

/** A short human-readable line for the roster, or null if not worth showing. */
export function activityLine(event: ClaudeEvent): string | null {
  if (event.type !== "assistant") return null;
  const content = (event as AssistantEvent).message?.content ?? [];
  for (const block of content) {
    if (block.type === "tool_use" && block.name) return block.name;
  }
  return null;
}
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `pnpm vitest run tests/stream-codec.test.ts`
Expected: PASS, 9 tests

- [ ] **Step 7: Commit**

```bash
git add package.json pnpm-lock.yaml tsconfig.json vitest.config.ts src/shared/types.ts src/daemon/stream-codec.ts tests/stream-codec.test.ts
git commit -m "Add project scaffolding and the stream-json codec"
```

---

### Task 2: Worktree creation and bootstrap

Creating the worktree is trivial. Making it *runnable* is the real work — observed on teledoctor, where existing worktrees have neither `node_modules` nor `.env`.

Bootstrap takes an injectable command runner so unit tests are fast and one integration test exercises the real thing.

**Files:**
- Create: `src/daemon/worktree.ts`
- Create: `src/daemon/bootstrap.ts`
- Create: `tests/helpers/scratch-repo.ts`
- Test: `tests/worktree.test.ts`, `tests/bootstrap.test.ts`

**Interfaces:**
- Consumes: nothing from Task 1
- Produces:
  - `createWorktree(repo: string, label: string): Promise<{ worktree: string; branch: string }>`
  - `excludeBenchDir(repo: string): Promise<void>`
  - `bootstrapWorktree(opts: BootstrapOptions): Promise<BootstrapResult>` where
    `BootstrapOptions = { repo: string; worktree: string; port: number; onStep?: (name: string) => void; run?: RunFn }`,
    `RunFn = (cmd: string, args: string[], cwd: string) => Promise<{ code: number; stderr: string }>`,
    `BootstrapResult = { port: number; steps: string[] }`
  - `class BootstrapError extends Error { step: string; stderr: string }`

- [ ] **Step 1: Write the scratch repo fixture**

`tests/helpers/scratch-repo.ts`:

```ts
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

/** A throwaway git repo with one commit, shaped like a small pnpm project. */
export async function makeScratchRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "bench-scratch-"));
  await exec("git", ["init", "-q", "-b", "main"], { cwd: dir });
  await exec("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  await exec("git", ["config", "user.name", "Test"], { cwd: dir });
  await mkdir(join(dir, ".git", "info"), { recursive: true });
  await writeFile(join(dir, "package.json"), JSON.stringify({ name: "scratch", version: "1.0.0" }));
  await writeFile(join(dir, ".env"), "SECRET=shh\n");
  await writeFile(join(dir, "README.md"), "scratch\n");
  await exec("git", ["add", "-A"], { cwd: dir });
  await exec("git", ["commit", "-q", "-m", "init"], { cwd: dir });
  return dir;
}
```

- [ ] **Step 2: Write the failing worktree test**

`tests/worktree.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { makeScratchRepo } from "./helpers/scratch-repo.js";
import { createWorktree, excludeBenchDir } from "../src/daemon/worktree.js";

const exec = promisify(execFile);

describe("createWorktree", () => {
  it("creates a worktree under .claude/worktrees on its own branch", async () => {
    const repo = await makeScratchRepo();
    const { worktree, branch } = await createWorktree(repo, "auth-refresh");

    expect(worktree).toBe(join(repo, ".claude", "worktrees", "auth-refresh"));
    expect(branch).toBe("worktree-auth-refresh");

    const { stdout } = await exec("git", ["worktree", "list"], { cwd: repo });
    expect(stdout).toContain(worktree);
  });

  it("rejects a label that would escape the worktrees directory", async () => {
    const repo = await makeScratchRepo();
    await expect(createWorktree(repo, "../../etc")).rejects.toThrow(/invalid label/i);
  });

  it("never returns a Windows or UNC path", async () => {
    const repo = await makeScratchRepo();
    const { worktree } = await createWorktree(repo, "plain");
    expect(worktree.startsWith("/")).toBe(true);
    expect(worktree).not.toContain("\\");
  });
});

describe("excludeBenchDir", () => {
  it("excludes .bench via .git/info/exclude, leaving .gitignore untouched", async () => {
    const repo = await makeScratchRepo();
    await excludeBenchDir(repo);

    const exclude = await readFile(join(repo, ".git", "info", "exclude"), "utf8");
    expect(exclude).toContain(".bench/");

    const { stdout } = await exec("git", ["status", "--porcelain"], { cwd: repo });
    expect(stdout).not.toContain(".gitignore");
  });

  it("is idempotent", async () => {
    const repo = await makeScratchRepo();
    await excludeBenchDir(repo);
    await excludeBenchDir(repo);
    const exclude = await readFile(join(repo, ".git", "info", "exclude"), "utf8");
    expect(exclude.match(/\.bench\//g)).toHaveLength(1);
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `pnpm vitest run tests/worktree.test.ts`
Expected: FAIL — cannot resolve `../src/daemon/worktree.js`

- [ ] **Step 4: Write `src/daemon/worktree.ts`**

```ts
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

const exec = promisify(execFile);

const LABEL_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

export async function createWorktree(
  repo: string,
  label: string,
): Promise<{ worktree: string; branch: string }> {
  if (!LABEL_PATTERN.test(label)) {
    throw new Error(`invalid label: ${label}`);
  }

  const worktree = join(repo, ".claude", "worktrees", label);
  const branch = `worktree-${label}`;

  await mkdir(join(repo, ".claude", "worktrees"), { recursive: true });
  await exec("git", ["worktree", "add", "-b", branch, worktree], { cwd: repo });

  return { worktree, branch };
}

export async function excludeBenchDir(repo: string): Promise<void> {
  const excludePath = join(repo, ".git", "info", "exclude");
  await mkdir(join(repo, ".git", "info"), { recursive: true });

  let current = "";
  try {
    current = await readFile(excludePath, "utf8");
  } catch {
    current = "";
  }

  if (current.split("\n").some((line) => line.trim() === ".bench/")) return;

  const next = current.endsWith("\n") || current === "" ? current : current + "\n";
  await writeFile(excludePath, next + ".bench/\n");
}
```

- [ ] **Step 5: Run it to verify it passes**

Run: `pnpm vitest run tests/worktree.test.ts`
Expected: PASS, 5 tests

- [ ] **Step 6: Write the failing bootstrap test**

`tests/bootstrap.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { lstat, readlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { makeScratchRepo } from "./helpers/scratch-repo.js";
import { createWorktree } from "../src/daemon/worktree.js";
import { bootstrapWorktree, BootstrapError } from "../src/daemon/bootstrap.js";

const okRun = async () => ({ code: 0, stderr: "" });

describe("bootstrapWorktree", () => {
  it("symlinks .env from the main checkout instead of copying it", async () => {
    const repo = await makeScratchRepo();
    const { worktree } = await createWorktree(repo, "envtest");

    await bootstrapWorktree({ repo, worktree, port: 3101, run: okRun });

    const link = join(worktree, ".env");
    expect((await lstat(link)).isSymbolicLink()).toBe(true);
    expect(await readlink(link)).toBe(join(repo, ".env"));
  });

  it("reports each step it ran, in order", async () => {
    const repo = await makeScratchRepo();
    const { worktree } = await createWorktree(repo, "steps");

    const seen: string[] = [];
    const result = await bootstrapWorktree({
      repo, worktree, port: 3102, run: okRun, onStep: (s) => seen.push(s),
    });

    expect(seen[0]).toBe("install");
    expect(seen).toContain("env");
    expect(result.port).toBe(3102);
  });

  it("skips prisma generate when the project has no prisma dependency", async () => {
    const repo = await makeScratchRepo();
    const { worktree } = await createWorktree(repo, "noprisma");

    const seen: string[] = [];
    await bootstrapWorktree({ repo, worktree, port: 3103, run: okRun, onStep: (s) => seen.push(s) });

    expect(seen).not.toContain("prisma");
  });

  it("runs prisma generate when prisma is a dependency", async () => {
    const repo = await makeScratchRepo();
    await writeFile(
      join(repo, "package.json"),
      JSON.stringify({ name: "scratch", devDependencies: { prisma: "^7.0.0" } }),
    );
    const { worktree } = await createWorktree(repo, "prisma");

    const seen: string[] = [];
    await bootstrapWorktree({ repo, worktree, port: 3104, run: okRun, onStep: (s) => seen.push(s) });

    expect(seen).toContain("prisma");
  });

  it("surfaces the failing step and its stderr", async () => {
    const repo = await makeScratchRepo();
    const { worktree } = await createWorktree(repo, "failing");

    const failingRun = async () => ({ code: 1, stderr: "ERR_PNPM_NO_LOCKFILE" });

    await expect(
      bootstrapWorktree({ repo, worktree, port: 3105, run: failingRun }),
    ).rejects.toMatchObject({
      step: "install",
      stderr: expect.stringContaining("ERR_PNPM_NO_LOCKFILE"),
    });
  });

  it("throws a BootstrapError, not a bare Error", async () => {
    const repo = await makeScratchRepo();
    const { worktree } = await createWorktree(repo, "errtype");
    const failingRun = async () => ({ code: 1, stderr: "boom" });

    await expect(
      bootstrapWorktree({ repo, worktree, port: 3106, run: failingRun }),
    ).rejects.toBeInstanceOf(BootstrapError);
  });
});
```

- [ ] **Step 7: Run it to verify it fails**

Run: `pnpm vitest run tests/bootstrap.test.ts`
Expected: FAIL — cannot resolve `../src/daemon/bootstrap.js`

- [ ] **Step 8: Write `src/daemon/bootstrap.ts`**

```ts
import { execFile } from "node:child_process";
import { readFile, symlink, access } from "node:fs/promises";
import { join } from "node:path";

export type RunFn = (
  cmd: string,
  args: string[],
  cwd: string,
) => Promise<{ code: number; stderr: string }>;

export interface BootstrapOptions {
  repo: string;
  worktree: string;
  port: number;
  onStep?: (name: string) => void;
  run?: RunFn;
}

export interface BootstrapResult {
  port: number;
  steps: string[];
}

export class BootstrapError extends Error {
  constructor(
    readonly step: string,
    readonly stderr: string,
  ) {
    super(`bootstrap step "${step}" failed: ${stderr.trim().slice(0, 400)}`);
    this.name = "BootstrapError";
  }
}

/** Files that never live in git but that the app needs to run. */
const ENV_FILES = [".env", ".env.local", ".env.production"];

const defaultRun: RunFn = (cmd, args, cwd) =>
  new Promise((resolve) => {
    execFile(cmd, args, { cwd, maxBuffer: 32 * 1024 * 1024 }, (error, _stdout, stderr) => {
      resolve({ code: error ? 1 : 0, stderr: stderr ?? String(error ?? "") });
    });
  });

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function usesPrisma(repo: string): Promise<boolean> {
  try {
    const pkg = JSON.parse(await readFile(join(repo, "package.json"), "utf8"));
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    return "prisma" in deps || "@prisma/client" in deps;
  } catch {
    return false;
  }
}

/**
 * A fresh worktree has no node_modules and no env files, so it cannot run
 * anything. This makes it runnable, and fails loudly on the step that broke
 * rather than leaving the agent to discover it at its first test run.
 */
export async function bootstrapWorktree(opts: BootstrapOptions): Promise<BootstrapResult> {
  const { repo, worktree, port, onStep } = opts;
  const run = opts.run ?? defaultRun;
  const steps: string[] = [];

  const step = async (name: string, fn: () => Promise<void>) => {
    steps.push(name);
    onStep?.(name);
    await fn();
  };

  await step("install", async () => {
    const { code, stderr } = await run("pnpm", ["install", "--prefer-offline"], worktree);
    if (code !== 0) throw new BootstrapError("install", stderr);
  });

  await step("env", async () => {
    for (const file of ENV_FILES) {
      const source = join(repo, file);
      const target = join(worktree, file);
      if (!(await exists(source))) continue;
      if (await exists(target)) continue;
      // Symlink, never copy: secrets keep one source of truth on disk.
      await symlink(source, target);
    }
  });

  if (await usesPrisma(repo)) {
    await step("prisma", async () => {
      const { code, stderr } = await run("pnpm", ["exec", "prisma", "generate"], worktree);
      if (code !== 0) throw new BootstrapError("prisma", stderr);
    });
  }

  return { port, steps };
}
```

- [ ] **Step 9: Run it to verify it passes**

Run: `pnpm vitest run tests/bootstrap.test.ts`
Expected: PASS, 6 tests

- [ ] **Step 10: Commit**

```bash
git add src/daemon/worktree.ts src/daemon/bootstrap.ts tests/helpers/scratch-repo.ts tests/worktree.test.ts tests/bootstrap.test.ts
git commit -m "Add git worktree creation and bootstrap"
```

---

### Task 3: Gate hooks

Rules that matter are hooks, not prose. Two gates in Slice 1: commit attribution, and report-required.

The output contracts below were read out of the `claude 2.1.238` bundle and are exact. Note the asymmetry: `PreToolUse` blocks via `hookSpecificOutput.permissionDecision`, but `Stop` **cannot** block that way — its `hookSpecificOutput` accepts only `additionalContext`, which is non-blocking feedback. Blocking a `Stop` requires the top-level `{"decision":"block","reason":"..."}` form.

**Files:**
- Create: `src/daemon/gates/commit-attribution.ts`
- Create: `src/daemon/gates/report-required.ts`
- Create: `src/daemon/gates/settings.ts`
- Create: `src/daemon/hooks/bench-hook.ts`
- Test: `tests/gates.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `evaluateCommit(command: string): { deny: boolean; reason: string }`
  - `evaluateStop(opts: { reportsDir: string; turn: number }): Promise<{ block: boolean; reason: string }>`
  - `buildSettings(opts: { hookCommand: string }): object`

- [ ] **Step 1: Write the failing test**

`tests/gates.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evaluateCommit } from "../src/daemon/gates/commit-attribution.js";
import { evaluateStop } from "../src/daemon/gates/report-required.js";
import { buildSettings } from "../src/daemon/gates/settings.js";

describe("evaluateCommit", () => {
  it("denies a Co-Authored-By trailer", () => {
    const r = evaluateCommit('git commit -m "fix thing\n\nCo-Authored-By: Claude <noreply@anthropic.com>"');
    expect(r.deny).toBe(true);
  });

  it("denies a Generated with Claude Code footer", () => {
    const r = evaluateCommit('git commit -m "feat: x\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)"');
    expect(r.deny).toBe(true);
  });

  it("denies an Anthropic co-author trailer", () => {
    expect(evaluateCommit('git commit -m "x\n\nCo-authored-by: Anthropic"').deny).toBe(true);
  });

  it("allows an ordinary commit", () => {
    expect(evaluateCommit('git commit -m "fix: correct the port allocation"').deny).toBe(false);
  });

  it("allows a commit that merely mentions claude as subject matter", () => {
    // The rule bans attribution, not the word. This must not become a
    // keyword filter that blocks legitimate work on Claude-related files.
    expect(evaluateCommit('git commit -m "docs: document the CLAUDE.md precedence rule"').deny).toBe(false);
  });

  it("ignores commands that are not git commit", () => {
    expect(evaluateCommit('echo "Co-Authored-By: Claude"').deny).toBe(false);
  });

  it("gives a reason explaining what to do instead", () => {
    const r = evaluateCommit('git commit -m "x\n\nCo-Authored-By: Claude <noreply@anthropic.com>"');
    expect(r.reason).toMatch(/attribution/i);
  });
});

describe("evaluateStop", () => {
  const makeReports = async () => mkdtemp(join(tmpdir(), "bench-reports-"));

  it("blocks when the turn produced no report", async () => {
    const reportsDir = await makeReports();
    const r = await evaluateStop({ reportsDir, turn: 1 });
    expect(r.block).toBe(true);
    expect(r.reason).toMatch(/report/i);
  });

  it("allows when the turn produced a report", async () => {
    const reportsDir = await makeReports();
    await mkdir(join(reportsDir, "1"), { recursive: true });
    await writeFile(join(reportsDir, "1", "report.html"), "<h1>done</h1>");

    const r = await evaluateStop({ reportsDir, turn: 1 });
    expect(r.block).toBe(false);
  });

  it("blocks when only an older turn's report exists", async () => {
    const reportsDir = await makeReports();
    await mkdir(join(reportsDir, "1"), { recursive: true });
    await writeFile(join(reportsDir, "1", "report.html"), "<h1>old</h1>");

    const r = await evaluateStop({ reportsDir, turn: 2 });
    expect(r.block).toBe(true);
  });

  it("blocks when the directory exists but report.html does not", async () => {
    const reportsDir = await makeReports();
    await mkdir(join(reportsDir, "1"), { recursive: true });

    const r = await evaluateStop({ reportsDir, turn: 1 });
    expect(r.block).toBe(true);
  });
});

describe("buildSettings", () => {
  it("registers a PreToolUse Bash hook and a Stop hook", () => {
    const settings = buildSettings({ hookCommand: "node /opt/bench/hook.js" }) as any;

    const pre = settings.hooks.PreToolUse;
    expect(pre[0].matcher).toBe("Bash");
    expect(pre[0].hooks[0].command).toContain("commit-attribution");

    const stop = settings.hooks.Stop;
    expect(stop[0].hooks[0].command).toContain("report-required");
  });

  it("serialises to JSON, since it is passed to --settings as a string", () => {
    const settings = buildSettings({ hookCommand: "node /opt/bench/hook.js" });
    expect(() => JSON.parse(JSON.stringify(settings))).not.toThrow();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run tests/gates.test.ts`
Expected: FAIL — cannot resolve the gate modules

- [ ] **Step 3: Write `src/daemon/gates/commit-attribution.ts`**

```ts
/**
 * Bans attribution, not the word "Claude". A commit that documents
 * CLAUDE.md is legitimate work; a commit that credits Claude as an author
 * is the thing being prevented. Matching trailers and footers rather than
 * keywords is what keeps this from becoming a nuisance filter.
 */
const ATTRIBUTION_PATTERNS: RegExp[] = [
  /co-authored-by:\s*(claude|anthropic)/i,
  /generated\s+with\s+\[?claude/i,
  /🤖\s*generated\s+with/i,
  /\bauthored\s+by\s+claude\b/i,
];

const REASON =
  "Blocked: this commit message carries AI attribution. " +
  "Commits in this project must never credit Claude or Anthropic — " +
  "no Co-Authored-By trailer, no 'Generated with' footer. " +
  "Rewrite the message describing only what changed, then commit again.";

export function evaluateCommit(command: string): { deny: boolean; reason: string } {
  if (!/\bgit\b[\s\S]*\bcommit\b/.test(command)) {
    return { deny: false, reason: "" };
  }

  for (const pattern of ATTRIBUTION_PATTERNS) {
    if (pattern.test(command)) return { deny: true, reason: REASON };
  }

  return { deny: false, reason: "" };
}
```

- [ ] **Step 4: Write `src/daemon/gates/report-required.ts`**

```ts
import { access } from "node:fs/promises";
import { join } from "node:path";

const REASON =
  "Blocked: you have not written a report for this turn. " +
  "A Specialist may not end a turn without one. " +
  "Invoke the bench-report skill and write report.html and decision.json " +
  "into the report directory for this turn, then finish.";

/**
 * "Reports at end of work" as a mechanism rather than a request. The turn
 * number comes from the daemon, which increments it before each turn.
 */
export async function evaluateStop(opts: {
  reportsDir: string;
  turn: number;
}): Promise<{ block: boolean; reason: string }> {
  const candidate = join(opts.reportsDir, String(opts.turn), "report.html");
  try {
    await access(candidate);
    return { block: false, reason: "" };
  } catch {
    return { block: true, reason: REASON };
  }
}
```

- [ ] **Step 5: Write `src/daemon/gates/settings.ts`**

```ts
/**
 * Built per session and passed to `claude --settings '<json>'`, so gates
 * never live in the repo being worked on and a project cannot remove them.
 * Hooks are additive, which is why loading project settings alongside these
 * is safe: a project can add hooks, never delete one of ours.
 */
export function buildSettings(opts: { hookCommand: string }): object {
  return {
    hooks: {
      PreToolUse: [
        {
          matcher: "Bash",
          hooks: [{ type: "command", command: `${opts.hookCommand} commit-attribution` }],
        },
      ],
      Stop: [
        {
          hooks: [{ type: "command", command: `${opts.hookCommand} report-required` }],
        },
      ],
    },
  };
}
```

- [ ] **Step 6: Write `src/daemon/hooks/bench-hook.ts`**

```ts
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { evaluateCommit } from "../gates/commit-attribution.js";
import { evaluateStop } from "../gates/report-required.js";

/**
 * Invoked by Claude Code as a hook command. Reads the hook payload as JSON
 * on stdin, writes a decision as JSON on stdout, exits 0.
 *
 * Output contracts verified against claude 2.1.238:
 *   PreToolUse -> { hookSpecificOutput: { hookEventName, permissionDecision, permissionDecisionReason } }
 *   Stop       -> { decision: "block", reason }   (Stop's hookSpecificOutput
 *                  only carries additionalContext, which does NOT block)
 *
 * Emitting nothing means "no opinion" and the tool call proceeds.
 */
async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

async function main(): Promise<void> {
  const gate = process.argv[2];
  const raw = await readStdin();

  let payload: Record<string, any> = {};
  try {
    payload = JSON.parse(raw);
  } catch {
    // An unreadable payload must never wedge the agent. Stay silent.
    return;
  }

  if (gate === "commit-attribution") {
    const command = String(payload.tool_input?.command ?? "");
    const { deny, reason } = evaluateCommit(command);
    if (!deny) return;

    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: reason,
        },
      }),
    );
    return;
  }

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

    const { block, reason } = await evaluateStop({ reportsDir, turn });
    if (!block) return;

    process.stdout.write(JSON.stringify({ decision: "block", reason }));
  }
}

main().catch(() => {
  // A crashing gate must fail open, never leave a session stuck.
  process.exit(0);
});
```

- [ ] **Step 7: Run the test to verify it passes**

Run: `pnpm vitest run tests/gates.test.ts`
Expected: PASS, 13 tests

- [ ] **Step 8: Commit**

```bash
git add src/daemon/gates src/daemon/hooks tests/gates.test.ts
git commit -m "Add commit-attribution and report-required gates"
```

---

### Task 4: The bench-report skill

The report contract, delivered to Specialists as a plugin so nothing is installed globally and the target repo is untouched. `BENCH_REPORT_DIR` is exported into the session environment by Task 5.

**Files:**
- Create: `plugin/.claude-plugin/plugin.json`
- Create: `plugin/skills/bench-report/SKILL.md`
- Test: `tests/plugin.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: a plugin directory path passed to `claude --plugin-dir`

- [ ] **Step 1: Write the failing test**

`tests/plugin.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const root = join(process.cwd(), "plugin");

describe("bench plugin", () => {
  it("has a valid manifest with a name and version", async () => {
    const manifest = JSON.parse(await readFile(join(root, ".claude-plugin", "plugin.json"), "utf8"));
    expect(manifest.name).toBe("bench");
    expect(manifest.version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("ships a bench-report skill with name and description frontmatter", async () => {
    const skill = await readFile(join(root, "skills", "bench-report", "SKILL.md"), "utf8");
    expect(skill.startsWith("---\n")).toBe(true);
    expect(skill).toMatch(/^name:\s*bench-report$/m);
    expect(skill).toMatch(/^description:\s*\S/m);
  });

  it("documents both required output files", async () => {
    const skill = await readFile(join(root, "skills", "bench-report", "SKILL.md"), "utf8");
    expect(skill).toContain("report.html");
    expect(skill).toContain("decision.json");
  });

  it("requires the verified / not verified split", async () => {
    const skill = await readFile(join(root, "skills", "bench-report", "SKILL.md"), "utf8");
    expect(skill).toMatch(/not verified/i);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run tests/plugin.test.ts`
Expected: FAIL — ENOENT on `plugin/.claude-plugin/plugin.json`

- [ ] **Step 3: Write `plugin/.claude-plugin/plugin.json`**

```json
{
  "name": "bench",
  "description": "The report contract for Bench specialists",
  "version": "0.1.0",
  "license": "MIT"
}
```

- [ ] **Step 4: Write `plugin/skills/bench-report/SKILL.md`**

```markdown
---
name: bench-report
description: Use when you have finished a piece of work or produced a spec that needs approval - writes the report page and decision the developer reads to make a call.
---

# Writing a Bench report

Your developer does not read your transcript. They read one page and press
one key. That page is the entire interface between your work and their
decision, so it is written for deciding, not for narrating.

Bench names your report directory at the start of every turn, in the line
that begins `[bench] Turn N`. Write both files there:

- `report.html` - what you did and what it means
- `decision.json` - the question you need answered

## report.html

A complete HTML fragment. No `<html>`, `<head>` or `<body>` tags, no
network requests, no external stylesheets or fonts. Inline any CSS you
need. It is rendered inside a sandboxed frame.

Required sections, in this order:

**1. The ask.** The first thing on the page is what you need decided and
why it matters. Not what you were assigned, not how you approached it.

**2. What changed.** In the application's terms, not the filesystem's.
"Password reset now expires tokens after one use" - not "modified
`auth.ts`, `tokens.ts`, `mailer.ts`".

**3. Evidence, only where the decision hinges on it.** A diff hunk of the
five lines that matter, never a whole file. If the developer does not need
to read code to decide, include none.

**4. Verified / Not verified.** Two explicit lists. Under *Verified*: what
you actually ran, with the command and its result. Under *Not verified*:
what you assumed, could not test, or ran out of scope to check. This is the
most valuable section on the page. An empty *Not verified* list is almost
always a lie - if you genuinely verified everything, say what would break
the verification.

**5. What you would do next** if the answer is simply "go".

Keep it to what fits on two screens. Use headings, short paragraphs and
tight lists. Detail that most readings will not need goes inside a
`<details>` element.

## decision.json

```json
{
  "kind": "spec_approval",
  "title": "Token expiry strategy for password reset",
  "summary": "Single-use tokens work, but the expiry window is your call.",
  "options": [
    { "id": "15m", "label": "15 minute expiry", "hint": "Matches the login OTP." },
    { "id": "1h", "label": "1 hour expiry", "hint": "Kinder on slow email delivery." }
  ],
  "allowFreeText": true
}
```

- `kind` - `spec_approval` when you need a plan approved before building,
  `question` when you are blocked mid-work, `completion` when work is done
  and needs review.
- `title` - a short noun phrase naming the decision.
- `summary` - one sentence. It is what the developer sees in the roster
  before opening the page.
- `options` - the concrete choices. Two to four. Each `hint` states the
  consequence of choosing it, not a restatement of the label. Omit or leave
  empty when there is nothing to choose between and you only need a reply.
- `allowFreeText` - keep `true` unless a free-text answer would be
  meaningless.

## Rules

- Never put approve or reject buttons in `report.html`. The decision
  controls are Bench's, and they are the same on every report so the
  developer builds muscle memory.
- Write `decision.json` last. Bench treats `report.html` as the signal that
  a report is ready.
- One report per turn. Write it and end your turn - Bench delivers the
  answer as your next message.
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm vitest run tests/plugin.test.ts`
Expected: PASS, 4 tests

- [ ] **Step 6: Commit**

```bash
git add plugin tests/plugin.test.ts
git commit -m "Add the bench-report skill plugin"
```

---

### Task 5: The Claude session

The process and turn lifecycle. A session is spawned once and lives across many turns; a turn ends on the `result` event and the process then blocks on stdin until an answer is written.

**Files:**
- Create: `src/daemon/claude-session.ts`
- Test: `tests/claude-session.test.ts`

**Interfaces:**
- Consumes: `LineDecoder`, `userMessageLine`, `isResultEvent`, `activityLine` (Task 1); `buildSettings` (Task 3)
- Produces:
  - `class ClaudeSession extends EventEmitter` with
    `constructor(opts: SessionOptions)`, `start(task: string): void`, `answer(text: string): void`, `stop(): void`, and readonly `id`, `turn`
  - `SessionOptions = { id: string; label: string; worktree: string; reportsDir: string; hookCommand: string; pluginDir: string; model: string; port: number; claudeBin?: string }`
  - events: `activity` (string), `turn-end` (ResultEvent), `exit` (code: number | null)

- [ ] **Step 1: Write the failing test**

Tests drive a fake `claude` binary — a Node script that speaks the same wire protocol — so the turn machinery is tested without API calls. Task 9 covers the real binary.

`tests/claude-session.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { mkdtemp, writeFile, chmod, mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { ClaudeSession } from "../src/daemon/claude-session.js";

/** A stand-in for the claude CLI that speaks stream-json over stdio. */
const FAKE_CLI = `#!/usr/bin/env node
process.stdout.write(JSON.stringify({ type: "system", subtype: "init" }) + "\\n");
let turn = 0;
let carry = "";
process.stdin.on("data", (chunk) => {
  carry += chunk.toString();
  const lines = carry.split("\\n");
  carry = lines.pop();
  for (const line of lines) {
    if (line.trim() === "") continue;
    turn += 1;
    const text = JSON.parse(line).message.content;
    process.stdout.write(JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "tool_use", name: "Bash" }] },
    }) + "\\n");
    process.stdout.write(JSON.stringify({
      type: "result", subtype: "success", is_error: false,
      session_id: "fake", result: "echo:" + text,
    }) + "\\n");
  }
});
`;

async function makeFakeCli(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "bench-fakecli-"));
  const path = join(dir, "fake-claude.mjs");
  await writeFile(path, FAKE_CLI);
  await chmod(path, 0o755);
  return path;
}

async function makeSession() {
  const claudeBin = await makeFakeCli();
  const worktree = await mkdtemp(join(tmpdir(), "bench-wt-"));
  const reportsDir = join(worktree, ".bench", "reports", "sess-1");
  await mkdir(reportsDir, { recursive: true });

  return new ClaudeSession({
    id: "sess-1",
    label: "tester",
    worktree,
    reportsDir,
    hookCommand: "node /nonexistent/hook.js",
    pluginDir: join(process.cwd(), "plugin"),
    model: "opus",
    port: 3100,
    claudeBin,
  });
}

describe("ClaudeSession", () => {
  it("emits turn-end when the result event arrives", async () => {
    const session = await makeSession();
    const ended = once(session, "turn-end");
    session.start("do the thing");

    const [result] = await ended;
    expect(result.type).toBe("result");
    // The message is framed with a turn header, so match on the payload.
    expect(result.result).toContain("do the thing");
    session.stop();
  });

  it("increments the turn counter across turns", async () => {
    const session = await makeSession();

    session.start("first");
    await once(session, "turn-end");
    expect(session.turn).toBe(1);

    session.answer("second");
    await once(session, "turn-end");
    expect(session.turn).toBe(2);

    session.stop();
  });

  it("delivers an answer as the next user message", async () => {
    const session = await makeSession();
    session.start("first");
    await once(session, "turn-end");

    const ended = once(session, "turn-end");
    session.answer("chose option A");
    const [result] = await ended;

    expect(result.result).toContain("chose option A");
    expect(result.result).toContain("Turn 2");
    session.stop();
  });

  it("emits activity lines for tool calls", async () => {
    const session = await makeSession();
    const seen: string[] = [];
    session.on("activity", (line: string) => seen.push(line));

    session.start("work");
    await once(session, "turn-end");

    expect(seen).toContain("Bash");
    session.stop();
  });

  it("emits exit when the process ends", async () => {
    const session = await makeSession();
    session.start("work");
    await once(session, "turn-end");

    const exited = once(session, "exit");
    session.stop();
    await exited;
  });

  it("writes a turn marker the report gate can read", async () => {
    const session = await makeSession();
    session.start("work");
    await once(session, "turn-end");

    const opts = (session as any).opts;
    const marker = await readFile(join(opts.reportsDir, ".turn"), "utf8");
    expect(marker).toBe("1");

    session.answer("next");
    await once(session, "turn-end");
    expect(await readFile(join(opts.reportsDir, ".turn"), "utf8")).toBe("2");

    session.stop();
  });

  it("refuses to answer before it has been started", async () => {
    const session = await makeSession();
    expect(() => session.answer("too early")).toThrow(/not started/i);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run tests/claude-session.test.ts`
Expected: FAIL — cannot resolve `../src/daemon/claude-session.js`

- [ ] **Step 3: Write `src/daemon/claude-session.ts`**

```ts
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LineDecoder, userMessageLine, isResultEvent, activityLine } from "./stream-codec.js";
import { buildSettings } from "./gates/settings.js";

export interface SessionOptions {
  id: string;
  label: string;
  worktree: string;
  reportsDir: string;
  hookCommand: string;
  pluginDir: string;
  model: string;
  port: number;
  claudeBin?: string;
}

/**
 * One long-lived `claude` process. In stream-json mode the process runs,
 * emits a `result` event, then blocks on stdin - so the turn is the unit of
 * control and no separate "needs input" protocol is required.
 */
export class ClaudeSession extends EventEmitter {
  readonly id: string;
  private child: ChildProcessWithoutNullStreams | null = null;
  private decoder = new LineDecoder();
  private turnCount = 0;

  constructor(private readonly opts: SessionOptions) {
    super();
    this.id = opts.id;
  }

  get turn(): number {
    return this.turnCount;
  }

  start(task: string): void {
    if (this.child) throw new Error("session already started");

    const bin = this.opts.claudeBin ?? "claude";
    const settings = JSON.stringify(buildSettings({ hookCommand: this.opts.hookCommand }));

    // --verbose is not optional: claude -p with stream-json exits without it.
    const args = [
      "-p",
      "--verbose",
      "--input-format", "stream-json",
      "--output-format", "stream-json",
      "--session-id", this.opts.id,
      "--name", this.opts.label,
      "--model", this.opts.model,
      "--permission-mode", "acceptEdits",
      "--settings", settings,
      "--plugin-dir", this.opts.pluginDir,
    ];

    this.child = spawn(bin, args, {
      cwd: this.opts.worktree,
      env: {
        ...process.env,
        BENCH_SESSION_ID: this.opts.id,
        BENCH_REPORTS_DIR: this.opts.reportsDir,
        PORT: String(this.opts.port),
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => this.consume(chunk));
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk: string) => this.emit("stderr", chunk));
    this.child.on("exit", (code) => {
      this.child = null;
      this.emit("exit", code);
    });

    this.beginTurn(1);
    this.child.stdin.write(userMessageLine(this.framed(task)));
  }

  answer(text: string): void {
    if (!this.child) throw new Error("session not started");
    this.beginTurn(this.turnCount + 1);
    this.child.stdin.write(userMessageLine(this.framed(text)));
  }

  /**
   * The turn number cannot live in the environment: env is fixed at spawn
   * and a session runs many turns. The gate reads it from this file, which
   * is rewritten before every turn.
   */
  private beginTurn(turn: number): void {
    this.turnCount = turn;
    mkdirSync(this.opts.reportsDir, { recursive: true });
    writeFileSync(join(this.opts.reportsDir, ".turn"), String(turn));
  }

  private framed(text: string): string {
    const reportDir = join(this.opts.reportsDir, String(this.turnCount));
    return `[bench] Turn ${this.turnCount}. Write this turn's report into ${reportDir}\n\n${text}`;
  }

  stop(): void {
    this.child?.kill("SIGTERM");
  }

  private consume(chunk: string): void {
    for (const event of this.decoder.push(chunk)) {
      const line = activityLine(event);
      if (line) this.emit("activity", line);
      if (isResultEvent(event)) this.emit("turn-end", event);
    }
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run tests/claude-session.test.ts`
Expected: PASS, 7 tests

- [ ] **Step 5: Commit**

```bash
git add src/daemon/claude-session.ts tests/claude-session.test.ts
git commit -m "Add the claude session process and turn lifecycle"
```

---

### Task 6: The reports store

Report discovery and decision parsing, including the degradation path — a malformed `decision.json` must produce a usable free-text reply, never a crash.

**Files:**
- Create: `src/daemon/reports.ts`
- Test: `tests/reports.test.ts`

**Interfaces:**
- Consumes: `decisionSchema`, `Decision` (Task 1)
- Produces:
  - `findReport(reportsDir: string, seq: number): Promise<ReportRecord | null>`
  - `latestReportSeq(reportsDir: string): Promise<number | null>`
  - `ReportRecord = { seq: number; htmlPath: string; decision: Decision; malformed: boolean }`

- [ ] **Step 1: Write the failing test**

`tests/reports.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findReport, latestReportSeq } from "../src/daemon/reports.js";

async function makeReportsDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "bench-rep-"));
}

async function writeReport(dir: string, seq: number, decision: unknown | null) {
  const target = join(dir, String(seq));
  await mkdir(target, { recursive: true });
  await writeFile(join(target, "report.html"), `<h1>report ${seq}</h1>`);
  if (decision !== null) {
    await writeFile(
      join(target, "decision.json"),
      typeof decision === "string" ? decision : JSON.stringify(decision),
    );
  }
}

const goodDecision = {
  kind: "completion",
  title: "Password reset",
  summary: "Done, one call needed.",
  options: [{ id: "ship", label: "Ship it" }],
  allowFreeText: true,
};

describe("findReport", () => {
  it("returns the report with its parsed decision", async () => {
    const dir = await makeReportsDir();
    await writeReport(dir, 1, goodDecision);

    const report = await findReport(dir, 1);
    expect(report?.decision.title).toBe("Password reset");
    expect(report?.malformed).toBe(false);
    expect(report?.htmlPath).toBe(join(dir, "1", "report.html"));
  });

  it("returns null when there is no report for that sequence", async () => {
    const dir = await makeReportsDir();
    expect(await findReport(dir, 7)).toBeNull();
  });

  it("degrades to a free-text decision when decision.json is missing", async () => {
    const dir = await makeReportsDir();
    await writeReport(dir, 1, null);

    const report = await findReport(dir, 1);
    expect(report?.malformed).toBe(true);
    expect(report?.decision.allowFreeText).toBe(true);
    expect(report?.decision.options).toEqual([]);
  });

  it("degrades when decision.json is unparseable", async () => {
    const dir = await makeReportsDir();
    await writeReport(dir, 1, "{ this is not json");

    const report = await findReport(dir, 1);
    expect(report?.malformed).toBe(true);
    expect(report?.decision.allowFreeText).toBe(true);
  });

  it("degrades when decision.json parses but fails the schema", async () => {
    const dir = await makeReportsDir();
    await writeReport(dir, 1, { kind: "nonsense", title: "" });

    const report = await findReport(dir, 1);
    expect(report?.malformed).toBe(true);
  });

  it("ignores a directory with decision.json but no report.html", async () => {
    const dir = await makeReportsDir();
    const target = join(dir, "1");
    await mkdir(target, { recursive: true });
    await writeFile(join(target, "decision.json"), JSON.stringify(goodDecision));

    expect(await findReport(dir, 1)).toBeNull();
  });
});

describe("latestReportSeq", () => {
  it("returns the highest sequence present", async () => {
    const dir = await makeReportsDir();
    await writeReport(dir, 1, goodDecision);
    await writeReport(dir, 2, goodDecision);
    expect(await latestReportSeq(dir)).toBe(2);
  });

  it("sorts numerically, not lexically", async () => {
    const dir = await makeReportsDir();
    await writeReport(dir, 2, goodDecision);
    await writeReport(dir, 10, goodDecision);
    expect(await latestReportSeq(dir)).toBe(10);
  });

  it("returns null when no reports exist", async () => {
    const dir = await makeReportsDir();
    expect(await latestReportSeq(dir)).toBeNull();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run tests/reports.test.ts`
Expected: FAIL — cannot resolve `../src/daemon/reports.js`

- [ ] **Step 3: Write `src/daemon/reports.ts`**

```ts
import { readFile, readdir, access } from "node:fs/promises";
import { join } from "node:path";
import { decisionSchema, type Decision } from "../shared/types.js";

export interface ReportRecord {
  seq: number;
  htmlPath: string;
  decision: Decision;
  malformed: boolean;
}

/**
 * When an agent writes a bad decision.json the developer still needs to be
 * able to reply. Degrading to free text keeps a malformed report from
 * wedging the session.
 */
function fallbackDecision(): Decision {
  return {
    kind: "question",
    title: "Report has no readable decision",
    summary: "The agent did not write a valid decision.json. Reply in free text.",
    options: [],
    allowFreeText: true,
  };
}

export async function findReport(reportsDir: string, seq: number): Promise<ReportRecord | null> {
  const dir = join(reportsDir, String(seq));
  const htmlPath = join(dir, "report.html");

  try {
    await access(htmlPath);
  } catch {
    // report.html is the readiness signal. Without it there is no report.
    return null;
  }

  try {
    const raw = await readFile(join(dir, "decision.json"), "utf8");
    const parsed = decisionSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) return { seq, htmlPath, decision: fallbackDecision(), malformed: true };
    return { seq, htmlPath, decision: parsed.data, malformed: false };
  } catch {
    return { seq, htmlPath, decision: fallbackDecision(), malformed: true };
  }
}

export async function latestReportSeq(reportsDir: string): Promise<number | null> {
  let entries: string[];
  try {
    entries = await readdir(reportsDir);
  } catch {
    return null;
  }

  const seqs = entries
    .map((name) => Number(name))
    .filter((n) => Number.isInteger(n) && n > 0)
    .sort((a, b) => b - a);

  for (const seq of seqs) {
    if (await findReport(reportsDir, seq)) return seq;
  }
  return null;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run tests/reports.test.ts`
Expected: PASS, 9 tests

- [ ] **Step 5: Commit**

```bash
git add src/daemon/reports.ts tests/reports.test.ts
git commit -m "Add report discovery and decision parsing"
```

---

### Task 7: Config and the server

Routes, token auth, the roster feed, and report serving. The client is given ids, never paths — that is what keeps a Windows path from ever reaching git.

**Files:**
- Create: `src/daemon/config.ts`
- Create: `src/daemon/server.ts`
- Create: `src/daemon/index.ts`
- Test: `tests/server.test.ts`

**Interfaces:**
- Consumes: `RosterRow`, `SessionStatus` (Task 1); `findReport`, `latestReportSeq` (Task 6); `ClaudeSession` (Task 5); `createWorktree`, `excludeBenchDir` (Task 2); `bootstrapWorktree` (Task 2)
- Produces:
  - `loadConfig(): BenchConfig` where `BenchConfig = { home: string; port: number; token: string; pluginDir: string; hookCommand: string }`
  - `createServer(opts: { config: BenchConfig; registry: SessionRegistry }): http.Server`
  - `class SessionRegistry` with `create(input)`, `get(id)`, `list(): RosterRow[]`, `answer(id, text)`, `stop(id)`, and an `EventEmitter` interface emitting `roster`

- [ ] **Step 1: Write the failing test**

`tests/server.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createServer } from "../src/daemon/server.js";
import type { RosterRow } from "../src/shared/types.js";

const TOKEN = "test-token-abc";

class StubRegistry extends EventEmitter {
  rows: RosterRow[] = [
    { id: "s1", label: "auth", project: "/var/www/demo", status: "awaiting_decision", detail: "waiting", latestReportSeq: 1 },
  ];
  answers: Array<{ id: string; text: string }> = [];
  reportsDir = "";

  list() { return this.rows; }
  get(id: string) { return id === "s1" ? { reportsDir: this.reportsDir } : null; }
  answer(id: string, text: string) { this.answers.push({ id, text }); }
  stop() {}
}

let server: ReturnType<typeof createServer>;
let base: string;
let registry: StubRegistry;

beforeAll(async () => {
  registry = new StubRegistry();

  const reportsDir = await mkdtemp(join(tmpdir(), "bench-srv-"));
  await mkdir(join(reportsDir, "1"), { recursive: true });
  await writeFile(join(reportsDir, "1", "report.html"), "<h1>hello report</h1>");
  await writeFile(
    join(reportsDir, "1", "decision.json"),
    JSON.stringify({ kind: "completion", title: "T", summary: "S", options: [], allowFreeText: true }),
  );
  registry.reportsDir = reportsDir;

  server = createServer({
    config: { home: "/tmp/bench", port: 0, token: TOKEN, pluginDir: "/tmp/plugin", hookCommand: "node hook.js" },
    registry: registry as any,
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => { server.close(); });

const auth = { headers: { "x-bench-token": TOKEN } };

describe("auth", () => {
  it("rejects a request with no token", async () => {
    const res = await fetch(`${base}/api/roster`);
    expect(res.status).toBe(401);
  });

  it("rejects a request with the wrong token", async () => {
    const res = await fetch(`${base}/api/roster`, { headers: { "x-bench-token": "nope" } });
    expect(res.status).toBe(401);
  });

  it("serves the UI shell without a token, since it has to bootstrap", async () => {
    const res = await fetch(`${base}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
  });
});

describe("GET /api/roster", () => {
  it("returns the roster rows", async () => {
    const res = await fetch(`${base}/api/roster`, auth);
    const body = await res.json();
    expect(body.rows[0].id).toBe("s1");
  });

  it("never leaks a filesystem path to the client", async () => {
    const res = await fetch(`${base}/api/roster`, auth);
    const text = await res.text();
    expect(text).not.toContain(".claude/worktrees");
  });
});

describe("GET /api/sessions/:id/report/:seq", () => {
  it("returns the decision for a report", async () => {
    const res = await fetch(`${base}/api/sessions/s1/report/1`, auth);
    const body = await res.json();
    expect(body.decision.title).toBe("T");
    expect(body.malformed).toBe(false);
  });

  it("404s for a report that does not exist", async () => {
    const res = await fetch(`${base}/api/sessions/s1/report/9`, auth);
    expect(res.status).toBe(404);
  });
});

describe("GET /r/:id/:seq/report.html", () => {
  it("serves the report body", async () => {
    const res = await fetch(`${base}/r/s1/1/report.html`, auth);
    expect(await res.text()).toContain("hello report");
  });

  it("sends a restrictive content security policy", async () => {
    const res = await fetch(`${base}/r/s1/1/report.html`, auth);
    expect(res.headers.get("content-security-policy")).toContain("default-src");
  });

  it("refuses a path traversal attempt in the sequence", async () => {
    const res = await fetch(`${base}/r/s1/..%2f..%2fetc/report.html`, auth);
    expect(res.status).toBe(400);
  });
});

describe("POST /api/sessions/:id/answer", () => {
  it("forwards the answer to the registry", async () => {
    const res = await fetch(`${base}/api/sessions/s1/answer`, {
      method: "POST",
      headers: { ...auth.headers, "content-type": "application/json" },
      body: JSON.stringify({ optionId: "ship", text: "go" }),
    });

    expect(res.status).toBe(200);
    expect(registry.answers[0].id).toBe("s1");
    expect(registry.answers[0].text).toContain("ship");
    expect(registry.answers[0].text).toContain("go");
  });

  it("404s for an unknown session", async () => {
    const res = await fetch(`${base}/api/sessions/nope/answer`, {
      method: "POST",
      headers: { ...auth.headers, "content-type": "application/json" },
      body: JSON.stringify({ text: "hi" }),
    });
    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run tests/server.test.ts`
Expected: FAIL — cannot resolve `../src/daemon/server.js`

- [ ] **Step 3: Write `src/daemon/config.ts`**

```ts
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export interface BenchConfig {
  home: string;
  port: number;
  token: string;
  pluginDir: string;
  hookCommand: string;
}

export function loadConfig(): BenchConfig {
  const home = process.env.BENCH_HOME ?? join(homedir(), ".bench");
  const port = Number(process.env.BENCH_PORT ?? "7420");
  const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

  return {
    home,
    port,
    token: randomBytes(24).toString("hex"),
    pluginDir: join(root, "plugin"),
    hookCommand: `node ${join(root, "dist", "daemon", "hooks", "bench-hook.js")}`,
  };
}
```

- [ ] **Step 4: Write `src/daemon/server.ts`**

```ts
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import type { BenchConfig } from "./config.js";
import { findReport } from "./reports.js";
import type { RosterRow } from "../shared/types.js";

export interface SessionRegistryLike {
  list(): RosterRow[];
  get(id: string): { reportsDir: string } | null;
  answer(id: string, text: string): void;
  stop(id: string): void;
  on(event: "roster", listener: () => void): unknown;
}

const CLIENT_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "client");

/** Reports are untrusted generated HTML: no network, no scripts from elsewhere. */
const REPORT_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:";

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(payload) });
  res.end(payload);
}

async function readBody(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return {};
  }
}

/** Turns the developer's choice into the message the agent receives. */
export function formatAnswer(optionId: string | undefined, text: string | undefined): string {
  const parts: string[] = [];
  if (optionId) parts.push(`[bench] decision: chose "${optionId}"`);
  if (text && text.trim() !== "") parts.push(text.trim());
  return parts.join("\n") || "[bench] decision: acknowledged";
}

export function createServer(opts: { config: BenchConfig; registry: SessionRegistryLike }) {
  const { config, registry } = opts;

  const server = createHttpServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const path = url.pathname;

    // The shell bootstraps without a token; everything with data behind it
    // requires one, so nothing else on the machine can drive the agents.
    if (path === "/" || path === "/app.js" || path === "/styles.css") {
      const file = path === "/" ? "index.html" : path.slice(1);
      const type = file.endsWith(".js") ? "text/javascript"
        : file.endsWith(".css") ? "text/css" : "text/html";
      try {
        const body = await readFile(join(CLIENT_DIR, file), "utf8");
        res.writeHead(200, { "content-type": `${type}; charset=utf-8` });
        res.end(body);
      } catch {
        res.writeHead(404).end("not found");
      }
      return;
    }

    const token = req.headers["x-bench-token"] ?? url.searchParams.get("token");
    if (token !== config.token) {
      json(res, 401, { error: "unauthorized" });
      return;
    }

    if (path === "/api/roster" && req.method === "GET") {
      json(res, 200, { rows: registry.list() });
      return;
    }

    const reportApi = path.match(/^\/api\/sessions\/([^/]+)\/report\/(\d+)$/);
    if (reportApi && req.method === "GET") {
      const session = registry.get(reportApi[1]);
      if (!session) { json(res, 404, { error: "no such session" }); return; }

      const report = await findReport(session.reportsDir, Number(reportApi[2]));
      if (!report) { json(res, 404, { error: "no such report" }); return; }

      json(res, 200, { seq: report.seq, decision: report.decision, malformed: report.malformed });
      return;
    }

    const reportHtml = path.match(/^\/r\/([^/]+)\/([^/]+)\/report\.html$/);
    if (reportHtml && req.method === "GET") {
      const seq = Number(reportHtml[2]);
      // The sequence is the only client-supplied part of the path, so it
      // must be a plain positive integer or the request is refused.
      if (!Number.isInteger(seq) || seq < 1) { res.writeHead(400).end("bad sequence"); return; }

      const session = registry.get(reportHtml[1]);
      if (!session) { res.writeHead(404).end("no such session"); return; }

      const report = await findReport(session.reportsDir, seq);
      if (!report) { res.writeHead(404).end("no such report"); return; }

      const body = await readFile(report.htmlPath, "utf8");
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "content-security-policy": REPORT_CSP,
      });
      res.end(body);
      return;
    }

    const answer = path.match(/^\/api\/sessions\/([^/]+)\/answer$/);
    if (answer && req.method === "POST") {
      if (!registry.get(answer[1])) { json(res, 404, { error: "no such session" }); return; }
      const body = await readBody(req);
      registry.answer(answer[1], formatAnswer(body.optionId, body.text));
      json(res, 200, { ok: true });
      return;
    }

    const stop = path.match(/^\/api\/sessions\/([^/]+)\/stop$/);
    if (stop && req.method === "POST") {
      if (!registry.get(stop[1])) { json(res, 404, { error: "no such session" }); return; }
      registry.stop(stop[1]);
      json(res, 200, { ok: true });
      return;
    }

    json(res, 404, { error: "not found" });
  });

  const wss = new WebSocketServer({ server, path: "/events" });
  wss.on("connection", (socket, req) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.searchParams.get("token") !== config.token) { socket.close(1008, "unauthorized"); return; }

    const send = () => socket.send(JSON.stringify({ type: "roster", rows: registry.list() }));
    send();
    registry.on("roster", send);
    socket.on("close", () => {
      (registry as unknown as { off(e: string, l: () => void): void }).off?.("roster", send);
    });
  });

  return server;
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm vitest run tests/server.test.ts`
Expected: PASS, 12 tests

- [ ] **Step 6: Write `src/daemon/index.ts`**

```ts
import { EventEmitter } from "node:events";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { loadConfig } from "./config.js";
import { createServer, type SessionRegistryLike } from "./server.js";
import { createWorktree, excludeBenchDir } from "./worktree.js";
import { bootstrapWorktree, BootstrapError } from "./bootstrap.js";
import { ClaudeSession } from "./claude-session.js";
import { latestReportSeq } from "./reports.js";
import type { RosterRow, SessionStatus } from "../shared/types.js";

interface Entry {
  row: RosterRow;
  reportsDir: string;
  session: ClaudeSession | null;
}

class SessionRegistry extends EventEmitter implements SessionRegistryLike {
  private entries = new Map<string, Entry>();

  constructor(private readonly config: ReturnType<typeof loadConfig>) {
    super();
  }

  list(): RosterRow[] {
    return [...this.entries.values()].map((e) => e.row);
  }

  get(id: string): { reportsDir: string } | null {
    const entry = this.entries.get(id);
    return entry ? { reportsDir: entry.reportsDir } : null;
  }

  private update(id: string, status: SessionStatus, detail: string): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    entry.row.status = status;
    entry.row.detail = detail;
    this.emit("roster");
  }

  async create(input: { project: string; label: string; task: string; model: string }): Promise<string> {
    const id = randomUUID();
    const reportsDir = join(input.project, ".bench", "reports", id);

    this.entries.set(id, {
      reportsDir,
      session: null,
      row: {
        id,
        label: input.label,
        project: input.project,
        status: "provisioning",
        detail: "creating worktree",
        latestReportSeq: null,
      },
    });
    this.emit("roster");

    try {
      await excludeBenchDir(input.project);
      const { worktree } = await createWorktree(input.project, input.label);
      await mkdir(reportsDir, { recursive: true });

      const port = 3100 + this.entries.size;
      await bootstrapWorktree({
        repo: input.project,
        worktree,
        port,
        onStep: (step) => this.update(id, "provisioning", step),
      });

      const session = new ClaudeSession({
        id,
        label: input.label,
        worktree,
        reportsDir,
        hookCommand: this.config.hookCommand,
        pluginDir: this.config.pluginDir,
        model: input.model,
        port,
      });

      session.on("activity", (line: string) => this.update(id, "working", line));
      session.on("exit", () => this.update(id, "crashed", "process exited"));
      session.on("turn-end", async () => {
        const entry = this.entries.get(id);
        if (entry) entry.row.latestReportSeq = await latestReportSeq(reportsDir);
        this.update(id, "awaiting_decision", "waiting on you");
      });

      this.entries.get(id)!.session = session;
      session.start(input.task);
      this.update(id, "working", "starting");
    } catch (error) {
      const detail = error instanceof BootstrapError
        ? `${error.step}: ${error.stderr.trim().slice(0, 200)}`
        : String(error);
      this.update(id, "provisioning_failed", detail);
    }

    return id;
  }

  answer(id: string, text: string): void {
    const entry = this.entries.get(id);
    if (!entry?.session) return;
    entry.session.answer(text);
    this.update(id, "working", "resumed");
  }

  stop(id: string): void {
    this.entries.get(id)?.session?.stop();
  }
}

const config = loadConfig();
const registry = new SessionRegistry(config);
const server = createServer({ config, registry });

server.listen(config.port, "127.0.0.1", () => {
  process.stdout.write(`bench: http://127.0.0.1:${config.port}/?token=${config.token}\n`);
});

// Children are killed deliberately so no orphaned claude processes survive
// the daemon.
const shutdown = () => {
  for (const row of registry.list()) registry.stop(row.id);
  server.close(() => process.exit(0));
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
```

- [ ] **Step 7: Add the create-session route**

In `src/daemon/server.ts`, add to `SessionRegistryLike`:

```ts
  create(input: { project: string; label: string; task: string; model: string }): Promise<string>;
```

and add this branch immediately before the `/api/roster` branch:

```ts
    if (path === "/api/sessions" && req.method === "POST") {
      const body = await readBody(req);
      if (!body.project || !body.label || !body.task) {
        json(res, 400, { error: "project, label and task are required" });
        return;
      }
      const id = await registry.create({
        project: String(body.project),
        label: String(body.label),
        task: String(body.task),
        model: String(body.model ?? "opus"),
      });
      json(res, 200, { id });
      return;
    }
```

Add `create` to `StubRegistry` in `tests/server.test.ts`:

```ts
  created: any[] = [];
  async create(input: any) { this.created.push(input); return "s2"; }
```

and this test to the file:

```ts
describe("POST /api/sessions", () => {
  it("creates a session and returns its id", async () => {
    const res = await fetch(`${base}/api/sessions`, {
      method: "POST",
      headers: { ...auth.headers, "content-type": "application/json" },
      body: JSON.stringify({ project: "/var/www/demo", label: "auth", task: "add reset" }),
    });
    expect((await res.json()).id).toBe("s2");
    expect(registry.created[0].label).toBe("auth");
  });

  it("400s when required fields are missing", async () => {
    const res = await fetch(`${base}/api/sessions`, {
      method: "POST",
      headers: { ...auth.headers, "content-type": "application/json" },
      body: JSON.stringify({ project: "/var/www/demo" }),
    });
    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 8: Run the full suite and typecheck**

Run: `pnpm vitest run && pnpm typecheck`
Expected: PASS, all tests; no type errors

- [ ] **Step 9: Commit**

```bash
git add src/daemon/config.ts src/daemon/server.ts src/daemon/index.ts tests/server.test.ts
git commit -m "Add daemon config, HTTP routes and the roster feed"
```

---

### Task 8: The cockpit client

Roster on the left, report in a sandboxed frame, decision bar pinned at the bottom. Number keys select, `Enter` confirms, `/` opens free text.

**Files:**
- Create: `src/client/index.html`
- Create: `src/client/styles.css`
- Create: `src/client/app.js`
- Modify: `package.json` (copy client into `dist` on build)

**Interfaces:**
- Consumes: `GET /api/roster`, `GET /api/sessions/:id/report/:seq`, `GET /r/:id/:seq/report.html`, `POST /api/sessions/:id/answer`, `POST /api/sessions`, `WS /events`
- Produces: nothing consumed by later tasks

- [ ] **Step 1: Write `src/client/index.html`**

```html
<main id="app">
  <aside id="roster">
    <header>
      <h1>Bench</h1>
      <button id="new-session" type="button">New specialist</button>
    </header>
    <ul id="roster-list"></ul>
  </aside>

  <section id="stage">
    <div id="empty">Select a specialist to read its report.</div>
    <iframe id="report" sandbox="allow-same-origin" title="Report" hidden></iframe>
    <footer id="decision" hidden>
      <div id="decision-head">
        <strong id="decision-title"></strong>
        <span id="decision-summary"></span>
      </div>
      <div id="decision-options"></div>
      <form id="decision-free" hidden>
        <input id="decision-text" type="text" placeholder="Type an answer, then Enter" />
      </form>
    </footer>
  </section>
</main>
<link rel="stylesheet" href="/styles.css" />
<script type="module" src="/app.js"></script>
```

- [ ] **Step 2: Write `src/client/styles.css`**

```css
:root {
  --bg: #ffffff;
  --panel: #f6f6f7;
  --line: #e2e2e5;
  --text: #16161a;
  --muted: #6b6b74;
  --accent: #2f6fed;
}

@media (prefers-color-scheme: dark) {
  :root {
    --bg: #131316;
    --panel: #1b1b20;
    --line: #2c2c33;
    --text: #ececed;
    --muted: #9b9ba4;
    --accent: #6f9bff;
  }
}

* { box-sizing: border-box; }

body {
  margin: 0;
  background: var(--bg);
  color: var(--text);
  font: 14px/1.5 ui-sans-serif, system-ui, sans-serif;
}

#app { display: grid; grid-template-columns: 280px 1fr; height: 100vh; }

#roster {
  background: var(--panel);
  border-right: 1px solid var(--line);
  display: flex;
  flex-direction: column;
  overflow-y: auto;
}

#roster header {
  padding: 16px;
  border-bottom: 1px solid var(--line);
  display: flex;
  align-items: center;
  justify-content: space-between;
}

#roster h1 { font-size: 15px; margin: 0; letter-spacing: 0.02em; }

#roster-list { list-style: none; margin: 0; padding: 0; }

.row {
  padding: 12px 16px;
  border-bottom: 1px solid var(--line);
  cursor: pointer;
}

.row[aria-selected="true"] { background: var(--bg); border-left: 2px solid var(--accent); }
.row .label { font-weight: 600; }
.row .detail { color: var(--muted); font-size: 12px; }

.status { font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted); }
.status[data-status="awaiting_decision"] { color: var(--accent); font-weight: 600; }
.status[data-status="provisioning_failed"],
.status[data-status="crashed"] { color: #d1453b; }

#stage { display: flex; flex-direction: column; min-width: 0; }
#empty { margin: auto; color: var(--muted); }
#report { flex: 1; width: 100%; border: 0; background: var(--bg); }

#decision { border-top: 1px solid var(--line); background: var(--panel); padding: 14px 18px; }
#decision-head { margin-bottom: 10px; }
#decision-summary { color: var(--muted); margin-left: 8px; }
#decision-options { display: flex; flex-wrap: wrap; gap: 8px; }

.option {
  border: 1px solid var(--line);
  background: var(--bg);
  color: var(--text);
  border-radius: 6px;
  padding: 8px 12px;
  cursor: pointer;
  text-align: left;
}

.option[aria-pressed="true"] { border-color: var(--accent); box-shadow: inset 0 0 0 1px var(--accent); }
.option .key { color: var(--muted); margin-right: 8px; font-variant-numeric: tabular-nums; }
.option .hint { display: block; color: var(--muted); font-size: 12px; }

#decision-text {
  width: 100%;
  margin-top: 10px;
  padding: 8px 10px;
  border: 1px solid var(--line);
  border-radius: 6px;
  background: var(--bg);
  color: var(--text);
}
```

- [ ] **Step 3: Write `src/client/app.js`**

```js
const token = new URLSearchParams(location.search).get("token") ?? "";
const authHeaders = { "x-bench-token": token };

const state = { rows: [], selectedId: null, report: null, choice: null };

const el = {
  list: document.getElementById("roster-list"),
  empty: document.getElementById("empty"),
  frame: document.getElementById("report"),
  bar: document.getElementById("decision"),
  title: document.getElementById("decision-title"),
  summary: document.getElementById("decision-summary"),
  options: document.getElementById("decision-options"),
  freeForm: document.getElementById("decision-free"),
  freeText: document.getElementById("decision-text"),
  newSession: document.getElementById("new-session"),
};

function renderRoster() {
  el.list.replaceChildren(
    ...state.rows.map((row) => {
      const li = document.createElement("li");
      li.className = "row";
      li.setAttribute("aria-selected", String(row.id === state.selectedId));
      li.onclick = () => select(row.id);

      const label = document.createElement("div");
      label.className = "label";
      label.textContent = row.label;

      const status = document.createElement("div");
      status.className = "status";
      status.dataset.status = row.status;
      status.textContent = row.status.replace(/_/g, " ");

      const detail = document.createElement("div");
      detail.className = "detail";
      detail.textContent = row.detail;

      li.append(label, status, detail);
      return li;
    }),
  );
}

function renderDecision() {
  const report = state.report;
  if (!report) {
    el.bar.hidden = true;
    return;
  }

  el.bar.hidden = false;
  el.title.textContent = report.decision.title;
  el.summary.textContent = report.decision.summary;
  state.choice = null;

  el.options.replaceChildren(
    ...report.decision.options.map((option, index) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "option";
      button.setAttribute("aria-pressed", "false");
      button.onclick = () => choose(option.id);

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
    }),
  );

  el.freeForm.hidden = !report.decision.allowFreeText;
}

function choose(optionId) {
  state.choice = optionId;
  const options = state.report.decision.options;
  [...el.options.children].forEach((button, index) => {
    button.setAttribute("aria-pressed", String(options[index].id === optionId));
  });
}

async function select(id) {
  state.selectedId = id;
  const row = state.rows.find((r) => r.id === id);
  renderRoster();

  if (!row || row.latestReportSeq === null) {
    el.frame.hidden = true;
    el.empty.hidden = false;
    state.report = null;
    renderDecision();
    return;
  }

  const res = await fetch(`/api/sessions/${id}/report/${row.latestReportSeq}`, { headers: authHeaders });
  state.report = res.ok ? await res.json() : null;

  el.empty.hidden = true;
  el.frame.hidden = false;
  el.frame.src = `/r/${id}/${row.latestReportSeq}/report.html?token=${encodeURIComponent(token)}`;
  renderDecision();
}

async function submit() {
  if (!state.selectedId || !state.report) return;

  await fetch(`/api/sessions/${state.selectedId}/answer`, {
    method: "POST",
    headers: { ...authHeaders, "content-type": "application/json" },
    body: JSON.stringify({ optionId: state.choice, text: el.freeText.value }),
  });

  el.freeText.value = "";
  state.report = null;
  state.choice = null;
  renderDecision();
}

document.addEventListener("keydown", (event) => {
  if (event.target === el.freeText) {
    if (event.key === "Enter") { event.preventDefault(); submit(); }
    if (event.key === "Escape") el.freeText.blur();
    return;
  }

  if (!state.report) return;

  if (event.key === "/") { event.preventDefault(); el.freeText.focus(); return; }
  if (event.key === "Enter") { event.preventDefault(); submit(); return; }

  const index = Number(event.key) - 1;
  const options = state.report.decision.options;
  if (Number.isInteger(index) && index >= 0 && index < options.length) {
    choose(options[index].id);
  }
});

el.newSession.onclick = async () => {
  const project = prompt("Project path (inside WSL)", "/var/www/teledoctor");
  if (!project) return;
  const label = prompt("Label (lowercase, hyphens)", "task-one");
  if (!label) return;
  const task = prompt("What should the specialist do?");
  if (!task) return;

  await fetch("/api/sessions", {
    method: "POST",
    headers: { ...authHeaders, "content-type": "application/json" },
    body: JSON.stringify({ project, label, task, model: "opus" }),
  });
};

function connect() {
  const socket = new WebSocket(`ws://${location.host}/events?token=${encodeURIComponent(token)}`);

  socket.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.type !== "roster") return;

    state.rows = message.rows;
    renderRoster();

    const current = state.rows.find((r) => r.id === state.selectedId);
    if (current && current.status === "awaiting_decision" && !state.report) select(current.id);
  };

  // The daemon outlives the UI, so a dropped socket is a reconnect, not an error.
  socket.onclose = () => setTimeout(connect, 1000);
}

connect();
```

- [ ] **Step 4: Copy the client on build**

In `package.json`, change the `build` script:

```json
"build": "tsc -p tsconfig.json && cp -r src/client dist/client"
```

- [ ] **Step 5: Verify the UI loads**

Run: `pnpm build && pnpm start`
Then open the printed `http://127.0.0.1:7420/?token=...` URL in a Windows browser.
Expected: the roster shell renders, "New specialist" is clickable, and the browser console shows no errors. Stop the daemon with `Ctrl-C`.

- [ ] **Step 6: Commit**

```bash
git add src/client package.json
git commit -m "Add the cockpit client"
```

---

### Task 9: End-to-end against the real CLI

Everything so far is tested against a fake CLI. This proves the real one: a Specialist runs, the report gate fires, a report appears, and an answer resumes the session.

This test makes real API calls. It uses a cheap model and is tagged so it can be skipped.

**Files:**
- Create: `tests/e2e.test.ts`
- Modify: `package.json` (add `test:e2e` script)

**Interfaces:**
- Consumes: everything
- Produces: nothing

- [ ] **Step 1: Add the script**

In `package.json`:

```json
"test:e2e": "BENCH_E2E=1 vitest run tests/e2e.test.ts"
```

- [ ] **Step 2: Write the test**

`tests/e2e.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ClaudeSession } from "../src/daemon/claude-session.js";
import { latestReportSeq, findReport } from "../src/daemon/reports.js";

const exec = promisify(execFile);
const run = process.env.BENCH_E2E === "1" ? describe : describe.skip;

const CHEAP_MODEL = "claude-haiku-4-5-20251001";

run("end to end against the real claude CLI", () => {
  it("runs a turn, writes a report through the gate, and resumes on an answer", async () => {
    const worktree = await mkdtemp(join(tmpdir(), "bench-e2e-"));
    await exec("git", ["init", "-q", "-b", "main"], { cwd: worktree });

    const reportsDir = join(worktree, ".bench", "reports", "e2e");
    await mkdir(join(reportsDir, "1"), { recursive: true });

    const session = new ClaudeSession({
      id: crypto.randomUUID(),
      label: "e2e",
      worktree,
      reportsDir,
      hookCommand: `node ${join(process.cwd(), "dist", "daemon", "hooks", "bench-hook.js")}`,
      pluginDir: join(process.cwd(), "plugin"),
      model: CHEAP_MODEL,
      port: 3199,
    });

    const ended = once(session, "turn-end");
    session.start(
      "Use the bench-report skill. Write report.html and decision.json into " +
      `${join(reportsDir, "1")}. The report should say the repo is empty. ` +
      "Offer two options with ids 'proceed' and 'stop'. Then finish.",
    );

    const [result] = await ended;
    expect(result.is_error).toBe(false);

    const seq = await latestReportSeq(reportsDir);
    expect(seq).toBe(1);

    const report = await findReport(reportsDir, 1);
    expect(report?.malformed).toBe(false);
    expect(report?.decision.options.map((o) => o.id)).toContain("proceed");

    const html = await readFile(report!.htmlPath, "utf8");
    expect(html.length).toBeGreaterThan(0);

    const resumed = once(session, "turn-end");
    session.answer('[bench] decision: chose "proceed"');
    const [second] = await resumed;
    expect(second.type).toBe("result");

    session.stop();
  }, 300_000);
});
```

- [ ] **Step 3: Build and run it**

Run: `pnpm build && pnpm test:e2e`
Expected: PASS, 1 test. If the report gate is working, the agent may be blocked once and retry — that is the gate doing its job, and the turn still ends successfully.

- [ ] **Step 4: Run the whole suite**

Run: `pnpm vitest run && pnpm typecheck`
Expected: all unit tests pass, no type errors

- [ ] **Step 5: Commit**

```bash
git add tests/e2e.test.ts package.json
git commit -m "Add end-to-end test against the real claude CLI"
```

---

## Manual verification

After Task 9, drive it by hand once — the whole point of Slice 1 is whether this beats reading a terminal, and only a real session answers that.

1. `pnpm build && pnpm start`
2. Open the printed URL in a Windows browser.
3. Create a specialist against a real project with a small, genuine task.
4. Watch the roster move through *provisioning* into *working*.
5. When it reaches *awaiting decision*, read the report and answer with the keyboard alone.
6. Confirm the session resumes and produces a second report.
7. Confirm `git worktree list` in the project shows the new worktree on a Linux path, with no UNC entry.
8. Confirm `git status` in the project is clean — `.bench/` must not appear.
