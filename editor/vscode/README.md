# Bench for VS Code

Opens the file a Bench specialist just wrote, as it writes it.

It connects to the Bench daemon already running on this machine and listens
for the edits it broadcasts. When a specialist writes a file inside a folder
this window has open — including one inside a specialist's worktree, which
lives under `<repo>/.claude/worktrees/` — the file opens here.

**It takes focus, every time.** That is the point, and it is not survivable in
the window you type in: this is made for a second monitor. Click the status-bar
item, or run **Bench: Pause or resume following edits**, to pause it without
disconnecting.

## The sidebar

A Bench view in the activity bar lists every specialist working on this
window's projects, and what each has changed since its branch started. Click a
file to see the diff.

The view carries a badge: how many specialists are waiting on a decision from
you, counting only projects this window has open. It counts a specialist as
waiting when it has written a report nobody has answered — not merely when it
has finished a turn.

Committed and uncommitted work both show. A file still only on disk says so,
because that is the work that could still be lost.

## Installing

```bash
npm install
npm run build
```

Then, in VS Code: **Developer: Install Extension from Location…** and pick this
folder. `npm run package` builds a `.vsix` instead.

Bench's root `pnpm install` deliberately does not cover this — it is a separate
package so the main checkout never grows `@types/vscode`.

## Configuration

None. It reads the token from `$BENCH_HOME/token` (default `~/.bench/token`)
and connects to `127.0.0.1:$BENCH_PORT` (default `7420`), which is the same
pair of rules the daemon itself uses. Start Bench after VS Code and it
connects on its own; restart the daemon and it reconnects.

It only ever talks to loopback. `BENCH_HOST` is ignored.

## The status bar

| | |
|---|---|
| 👁 Bench | following — files will open here |
| ⟳ Bench | connecting |
| ⚡ Bench | no daemon on this machine, retrying |
| 🔑 Bench | no token found; start Bench, or set `BENCH_HOME` |
| 🚫 Bench | paused — still connected, nothing will open |

## What it will not show you

Writes a specialist makes through the shell — `sed -i`, a `>` redirect — carry
no file path the daemon can see, so they do not open. Neither do Devin
specialists yet.

See `docs/specs/2026-09-15-editor-follow.md` for the design.
