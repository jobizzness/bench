# Bench

A bench of Claude Code specialists running in WSL, driven from a local web cockpit.

You send a specialist in on a task. It works silently in its own git worktree
and surfaces exactly twice — when a spec needs approving, and when the work is
done. Both times it surfaces as a rendered page built for a decision, not a log
built for a machine.

## Status

Running, with two known bugs. **[docs/STATUS.md](docs/STATUS.md)** is the
honest account: what is proven against the real CLI, what is built but
unproven, what is broken, and what was deliberately left out.

## Shape

A supervisor daemon (`benchd`) runs inside WSL and owns everything: `claude`
process lifecycle, git worktrees, gate enforcement, report storage, and serving
the UI. The client is a browser tab on `127.0.0.1:7420`.

Nothing Bench creates lives on the Windows filesystem, and no path ever crosses
the boundary — only bytes.
