# Editor follow — opening the file a specialist just wrote

*2026-09-15. Issues [#122](https://github.com/jobizzness/bench/issues/122)
(daemon) and [#123](https://github.com/jobizzness/bench/issues/123)
(extension).*

A VS Code window on a project opens whatever file a Bench specialist writes
there, as it is written.

## Why it is nearly free

The daemon already parses every tool call a specialist makes — that is where
the roster's activity trail comes from. `target()` in `stream-codec.ts` reads
the absolute path out of `file_path` / `notebook_path`, and then throws it
away: `shortPath()` trims it to `…/registry.ts` so it fits the ~35 characters
a phone's roster row can hold.

So the work was not *getting* the path. It was keeping a second, whole copy of
something already in hand.

## The two readings of one event

| | `activityLine()` | `fileTouch()` |
|---|---|---|
| For | the roster trail, on a phone | an editor, on this machine |
| Path | `shortPath()`ed, truncated to 72 chars | absolute, untouched |
| Tools | all of them | `Edit`, `MultiEdit`, `Write`, `NotebookEdit` |
| Missing tool call | returns `null` | returns `null` |

`Read` is deliberately absent from `fileTouch`. An editor that opened every
file an agent *looked at* would spend a grep of the codebase fighting the
developer for the screen.

## The path through the daemon

```
claude CLI  --stream-json-->  ClaudeSession.consume()
                                  |  fileTouch(event)
                                  v
                              emit("edit", { tool, path })
                                  |
                              SessionRegistry           tags it with id, label, project
                                  |  emit("edit", EditEvent)
                                  v
                              WS /events                { type: "edit", ... }
```

`EditEvent` lives in `src/shared/types.ts` beside `RosterRow`.

**It is a moment, not state.** Unlike the roster there is no snapshot sent on
connect and nothing is replayed. A client that reconnects has missed nothing it
could act on: the file it would have opened is already written.

**It is never mirrored.** Paths are facts about the machine the daemon runs
on. The registry only ever holds sessions this daemon spawned — rows from
another machine are merged in client-side, in `useRoster.ts` — so a remote
specialist structurally cannot produce one.

**Existing clients are unaffected.** The cockpit's socket handler matches on
`message.type === "roster"` and ignores everything else.

## The extension

`editor/vscode/`, its own package with its own `node_modules`. Deliberately
*not* in the pnpm workspace: the root install should not grow `@types/vscode`
for the sake of a thing most checkouts will never build.

| File | Does |
|---|---|
| `endpoint.ts` | `BENCH_HOME ?? ~/.bench` for the token, `BENCH_PORT ?? 7420` for the socket |
| `inside.ts` | whether a path is inside a folder this window has open |
| `follow.ts` | holds the socket, reconnects, pauses |
| `retry.ts` | opens a file that may not exist for another moment |
| `status.ts` | the status-bar item |
| `extension.ts` | the VS Code glue, and nothing else |

Everything but `status.ts` and `extension.ts` is free of any `vscode` import,
which is what lets `tests/editor-follow*.test.ts` and
`tests/editor-open-retry.test.ts` run in Bench's own suite.

### Why a worktree needs no second window

A worktree lives at `<repo>/.claude/worktrees/<label>-<id8>` — *inside* the
folder the developer already has open. So `insideWorkspace()` accepts it, and
the file opens in the existing window. A specialist with `isolated: false`
edits the developer's own file at the developer's own path.

`insideWorkspace` uses `path.relative`, not a prefix test: `/var/www/bench-old`
starts with `/var/www/bench`, and a string comparison would open an unrelated
checkout's files in the wrong window.

### Focus

It opens **focused, every time** — the developer's decision, taken with the
consequence stated: this is built for a second monitor and is not survivable
in the window you type in. The status-bar toggle is the way out, not a softer
default.

The tab is a *preview* tab, so consecutive edits reuse one rather than leaving
forty behind. That is a choice about hoarding tabs, not about focus.

### Loopback only

`endpoint.ts` ignores `BENCH_HOST`. Widening what the daemon *binds* to is a
decision about who may reach the machine; it is never a reason for an editor
already on that machine to look elsewhere. The token is the whole of the
daemon's authentication and reaching that port is reaching a shell.

## What it does not catch

- **Writes made through the shell.** `sed -i`, `>` redirects, `git checkout`.
  These produce no tool call carrying a path. Parsing one out of a command
  line would open the wrong file more often than the right one.
- **Devin specialists.** `devin-session.ts` emits `activity` as an
  already-formatted line with no structured path. Its own ticket.
- **Files outside every open folder.** By design — one daemon serves every
  project at once, and that filter is what lets several windows each follow
  only their own.

## Installing

```bash
cd editor/vscode && npm install && npm run build
```

Then point VS Code at the folder (`Developer: Install Extension from
Location…`), or `npm run package` for a `.vsix`. The root `pnpm install` does
not touch it.

`pnpm typecheck:editor` typechecks it, and needs that `npm install` to have
happened first — which is why it is a separate script rather than part of
`pnpm typecheck`.
