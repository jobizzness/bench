# Bench — design

Status: approved design, pre-implementation. Written 2026-08-21.

## What Bench is

A cockpit for running Claude Code agents. You keep a bench of specialists,
send one in on a task, and it comes back with a report you can read in
seconds and answer with a keystroke.

The agents run as real `claude` processes inside WSL. The cockpit is a web
UI served on localhost. You never read a terminal transcript to find out
what happened.

## The problem it solves

Driving Claude Code today means watching a scrolling transcript and
interrupting when something looks wrong. That does not scale past one
agent, and it puts the developer in the loop for things that do not need
them while burying the two or three moments that do.

Bench inverts it. Agents work silently and surface exactly twice: when a
spec needs approving, and when work is done. Both times they surface as a
rendered page built for a decision, not a log built for a machine.

## The agent model

Three roles.

**Specialist** — the primary actor and the only role you talk to. Always a
flagship model. Owns a task from spec through completion. Writes reports.
One git worktree per Specialist.

**Implementer** and **Reviewer** — spawned and reused by a Specialist,
running cheaper models. They report upward to their Specialist, never to
the developer, and structurally cannot write a report.

Role labels are editable when a session starts. In practice you will
mostly create Specialists and let them staff themselves.

## Architecture

A supervisor daemon (`benchd`) runs inside WSL and owns everything: process
lifecycle, git worktrees, gate enforcement, report storage, and serving the
UI. The client is a browser tab.

```
Windows                          WSL (Ubuntu)
─────────                        ─────────────────────────────────
browser  ──── HTTP/WS ─────────► benchd (127.0.0.1:7420)
localhost:7420                     │
                                   ├── claude ─── worktree A ── report
                                   ├── claude ─── worktree B ── report
                                   └── claude ─── worktree C ── report
```

### Why a daemon, and not the browser driving `wsl.exe`

Every feature in Bench is Linux-shaped: spawning processes, creating
worktrees, watching files, running `pnpm install`. Driving those from
Windows through `wsl.exe` shims puts the OS boundary inside every feature.
A daemon puts it in exactly one place — a documented localhost protocol —
and makes the client replaceable. Electron later wraps a thing that already
works rather than being the thing that works.

### Why not the Agent SDK

Rebuilding the agent loop on the SDK would trade away skills, plugins, MCP
and the `/command` ecosystem to regain control Bench does not need. Bench
supervises Claude Code; it does not reimplement it.

## The boundary rule

**Nothing Bench creates lives on the Windows filesystem, and no path ever
crosses the boundary — only bytes.**

Worktrees, reports, config, logs and session state are all Linux-side. The
client never opens a `\\wsl.localhost\...` path; it requests report content
over HTTP and renders it in a sandboxed frame with no filesystem access.

This is not hygiene, it is a correctness requirement. The teledoctor repo
already carries a locked worktree registered under
`//wsl.localhost/ubuntu/var/www/teledoctor/...` — the result of Windows and
WSL both claiming one repo. A client that never learns a path can never
write one back into git's worktree metadata.

## Session and process model

Each Specialist is one long-lived `claude` process the daemon owns,
launched with its cwd inside its own worktree:

```
claude -p --input-format stream-json --output-format stream-json \
  --session-id <uuid> --name "<label>" --model opus \
  --forward-subagent-text --include-hook-events \
  --agents '<implementer + reviewer definitions>' \
  --settings '<bench gate hooks>' --setting-sources user,project \
  --plugin-dir ~/.bench/plugin \
  --permission-mode plan
```

Verified against `claude 2.1.238`. Notable consequences:

- `--forward-subagent-text` emits subagent output tagged with
  `parent_tool_use_id`, so the roster tree is read from the stream rather
  than reconstructed.
- `--agents` defines Implementer and Reviewer at spawn time with their own
  models. Sub-agent roles never touch the target repo.
- `--settings` takes a JSON string, so gate hooks are injected per session
  and never live in the repo being worked on.
- `--session-id` means the daemon assigns identity up front instead of
  scraping it back out of the stream.
- `--plugin-dir` delivers the `bench-report` skill without installing
  anything globally.

`--setting-sources user,project` is deliberate: a repo's legitimate settings
still load. Hooks are additive and a project cannot remove one, so loading
project settings never weakens a gate. Bench's `--settings` string is the
floor, not the ceiling.

### The turn is the unit of control

In stream-json mode a session runs, emits a `result`, and then blocks on
stdin. That is the blocking primitive — there is no separate "I need input"
protocol to invent.

A Specialist finishes work, writes its report, and its turn ends. The
daemon sees `result`, sees the new report directory, renders it, and marks
the roster row *awaiting decision*. The developer's answer is written as a
single user message on that session's stdin, and the same session continues
with full context intact.

### Two phases, enforced by permission mode

A Specialist starts in `--permission-mode plan`. It cannot edit anything;
it can only produce a spec. That spec is the approval report. On approval
the daemon resumes the session into `acceptEdits` and it builds.

"A spec that needs approval" is therefore a permission boundary, not a
promise the model makes.

### Recovery

The daemon kills its children on exit deliberately, so no orphaned `claude`
processes survive it. Session ids and worktree paths are persisted to
`~/.bench/sessions.json`. On restart the daemon re-attaches by relaunching
with `--resume <session-id>`; reports on disk are unaffected. A session
whose process died unexpectedly shows as *crashed* in the roster with
resume offered.

## Reports and the decision loop

**The report is content. The decision is Bench chrome.**

If every report renders its own approve button, there is no muscle memory
and no cross-agent queue. So a report is two files:

```
<repo>/.bench/reports/<session-uuid>/<seq>/
  report.html     presentation: self-contained, no network, theme-aware
  decision.json   the ask, rendered by Bench in a fixed bar
```

`decision.json`:

```json
{
  "kind": "spec_approval | question | completion",
  "title": "Worktree bootstrap for Prisma repos",
  "summary": "Approach works, but .env handling needs your call.",
  "options": [
    { "id": "symlink", "label": "Symlink .env from main checkout",
      "hint": "Fastest. Breaks if the main checkout moves." },
    { "id": "copy", "label": "Copy per worktree",
      "hint": "Isolated, but drifts." }
  ],
  "allowFreeText": true
}
```

The HTML stays interactive for presentation — tabs, expandable diffs,
collapsed detail. It never owns the verdict. Bench renders the options as a
fixed bar: number keys select, `Enter` confirms, `/` opens free text.

Reports are served at `/r/<session>/<seq>/report.html` and rendered in a
sandboxed iframe. They are never loaded as `file://`.

### What a report must contain

Enforced by the `bench-report` skill:

- **The ask first.** The first screen is the decision, not a narrative.
- **Code only where the decision hinges on it** — the diff hunk, never the
  whole file.
- **A required Verified / Not verified split.** The agent states what it
  actually ran and what it only assumed. This is the single most valuable
  section on the page and it is mandatory.
- **What it would do next** if the answer is just "go".

### Answering

An answer is delivered as one structured user message on stdin:

```
[bench] decision for report <seq>: chose "symlink"
<free text, if any>
```

Deterministic enough for the agent to parse, readable enough to sit in the
transcript without noise.

### Malformed reports

If `report.html` exists but `decision.json` is missing or unparseable, the
daemon renders the page with a notice and offers free-text-only reply. A
bad report degrades the decision bar; it never breaks the UI or wedges the
agent.

## Worktrees

Bench reuses the convention the target repos already use:
`.claude/worktrees/<label>` on a `worktree-<label>` branch, so Bench's
worktrees stay legible to a plain `git worktree list`.

Creating the worktree is the easy half. Making it runnable is the friction —
observed on teledoctor, where existing worktrees have neither
`node_modules` nor `.env` and cannot run anything:

| Step | Why |
|---|---|
| `pnpm install` | 1.3G in the main checkout; pnpm's store hardlinks make it cheap on disk, not free in time |
| symlink `.env`, `.env.production` | never in git; symlinked rather than copied so secrets have one source of truth |
| `prisma generate` | the client lands in `node_modules/.prisma`, so it is per-worktree |
| assign a dev port | parallel `next dev` processes collide on 3000; the port is exported into the session env |

Bootstrap is a daemon job, not an agent job. The roster row shows
*provisioning* with the current step, and the Specialist does not get its
first turn until the worktree can run. Failure surfaces there, with the
failing step's stderr, instead of at the agent's first `pnpm test`.

`.bench/` is added to the target repo's `.git/info/exclude` rather than its
`.gitignore`, so Bench never dirties a repo it works in.

## Gates

Rules that matter are hooks, not prose. Prose rules stay advisory; the
critical ones become mechanically unbreakable regardless of what any
`CLAUDE.md` says. This is how a project's rules are prevented from
overriding global ones — not by merging text, but by making the global ones
non-negotiable at the tool-call layer.

Global gates, injected via `--settings` on every session:

| Gate | Event | Behaviour |
|---|---|---|
| Claude attribution in commits | `PreToolUse` Bash | deny any `git commit` whose message contains Claude/Anthropic attribution |
| Migration without the lock | `PreToolUse` Bash | deny `prisma migrate` / `supabase db push` unless the session holds the project's migration lock |
| Writes outside own worktree | `PreToolUse` Write/Edit | deny; agents cannot stomp each other |
| Publishing | `PreToolUse` Bash | deny `git push` and `gh pr create` for all agents; publishing is the developer's |
| Report required | `Stop` | block a Specialist ending a turn without a new report directory |

Project gates attach per repo and layer on top. The teledoctor i18n rule
(pull before adding keys, never edit existing values in git) is the first
candidate. Both layers are owned by Bench, so a repo cannot relax them.

### The migration lock

Worktrees isolate code. They do not isolate the database — Specialists on
separate branches still share one Supabase dev instance, and Prisma
migrations are not branch-scoped. The daemon holds a per-project lock with
an owner session id, released when that session ends or dies. An agent
without the lock is denied and told to wait, rather than corrupting another
agent's schema.

### Only Specialists write reports

The report path is keyed to the session uuid, which appears only in the
Specialist's own system prompt. Implementers and Reviewers never learn the
path, and the `Stop` gate applies only to Specialists. The rule is
structural, not requested.

## Protocol

`benchd` binds `127.0.0.1:7420` inside WSL; WSL2 localhost forwarding makes
it reachable from the Windows browser with no extra plumbing.

- `GET /` — the cockpit UI
- `GET /r/<session>/<seq>/*` — report assets
- `WS /events` — roster state, agent status transitions, decision prompts
- `POST /sessions` — create a Specialist (project, task, label, model)
- `POST /sessions/<id>/answer` — deliver a decision
- `POST /sessions/<id>/stop` — kill an agent

A token generated at daemon start is required on every request, so nothing
else on the machine can drive the agents.

## Errors

| Failure | Behaviour |
|---|---|
| Worktree bootstrap fails | roster shows *provisioning failed* with the failing step's stderr; the agent is never started |
| `claude` exits unexpectedly | row shows *crashed*; `--resume` offered; worktree and reports left intact |
| Daemon dies | browser shows disconnected and retries; children were killed with it; sessions resume from `~/.bench/sessions.json` |
| Malformed `decision.json` | report renders with a notice, free-text reply only |
| Lock holder dies | migration lock released with the session |

## Testing

The daemon is the testable surface and it is testable headlessly.

- **Gate hooks** are scripts that read a JSON tool call on stdin and emit an
  allow/deny decision. They are pure functions of their input and get
  straightforward unit tests, including the commit-attribution matcher
  against real commit messages that should and should not be blocked.
- **Worktree bootstrap** runs against a scratch git repo in a temp dir,
  asserting the worktree, the symlinks, the excluded `.bench/`, and a
  failing step surfacing as *provisioning failed*.
- **The session loop** is tested end to end against a real `claude` process
  with a canned prompt: assert a report directory appears, that the turn
  blocks, that an answer posted to `/sessions/<id>/answer` resumes it, and
  that the answer text reaches the transcript.
- **The report contract** is validated by a schema test on `decision.json`
  plus a malformed-input case proving the UI degrades rather than breaks.

## Scope: Slice 1

The full picture is three specs. Slice 1 proves the idea: does reading a
report and pressing a key actually beat reading a terminal?

**In scope.** One Specialist, on one project, in its own worktree. Worktree
bootstrap with the four steps above. The `claude` session loop with
stream-json in and out. `bench-report` skill delivered by plugin dir. The
`Stop` report gate and the commit-attribution gate. Report rendering and
the decision bar. Answers posted back into the live session. Roster showing
one row with live status.

Sections above describe the target architecture. Where one covers something
this slice excludes — recovery, the migration lock, concurrency, budgets —
it is specifying the shape that later slices build to, not work for Slice 1.

**Out of scope, deliberately.** Concurrent Specialists. The sub-agent tree.
The decision queue. The migration lock. Cross-worktree write denial.
Per-project gate sets. Budgets. Crash recovery via `--resume`. Editable
labels. Electron.

Slice 2 adds the fleet: concurrency, sub-agent tree, decision queue,
migration lock, cross-worktree denial. Slice 3 adds governance: per-project
gates, budgets, resume, labels. Electron wraps the finished web client.

## Stack

Node 22 and pnpm 10, matching the WSL toolchain already installed. The
daemon is TypeScript. The client is served by the daemon and stays
dependency-light — it renders a roster, an iframe, and a decision bar, and
nothing about that argues for a framework yet.
