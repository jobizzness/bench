# Bench

A bench of Claude Code specialists running in WSL, driven from a local web cockpit.

You send a specialist in on a task. It works silently in its own git worktree
and surfaces exactly twice — when a spec needs approving, and when the work is
done. Both times it surfaces as a rendered page built for a decision, not a log
built for a machine.

## Status

Design approved, implementation not started. Read
[`docs/superpowers/specs/2026-08-21-bench-design.md`](docs/superpowers/specs/2026-08-21-bench-design.md)
for the architecture and the Slice 1 scope.

## Shape

A supervisor daemon (`benchd`) runs inside WSL and owns everything: `claude`
process lifecycle, git worktrees, gate enforcement, report storage, and serving
the UI. The client is a browser tab on `127.0.0.1:7420`.

Nothing Bench creates lives on the Windows filesystem, and no path ever crosses
the boundary — only bytes.
