# Bench

**A bench of Claude Code specialists, and one page to decide from.**

Bench runs Claude Code as long-lived processes — *specialists* — each in its own
git worktree, and surfaces their work as decisions rather than transcripts. You
do not read the scrollback. You read one page and answer one question.

![The cockpit: a specialist waiting on a decision](docs/screenshots/decision.png)

## Why

Running an agent on a real task means one of two bad options: watch a terminal
scroll for twenty minutes, or come back later and reconstruct what happened from
a diff. Neither scales past one agent.

Bench takes the position that the interesting unit is not the message, it is the
**turn** — and that a turn which produced work owes you a page you can decide
from. A specialist writes a report when a decision needs you, when finished work
needs understanding, when a spec needs approving, or when it is stuck. The rest
of the time it just answers.

It is the same Claude Code you use in a terminal: every skill, every MCP server,
subagents, web search. Bench supervises it; it does not replace it.

## What it does

- **Specialists.** One long-lived `claude -p` process each, by default in its
  own git worktree on its own branch, with `node_modules` and `.env` symlinked
  from your checkout so it can build and test what it writes without an install
  of its own. Untick **Start in a worktree** and it works directly in your
  checkout instead, on the branch you already have open.
- **Nothing is installed, and nothing is copied.** A worktree borrows the
  dependencies your checkout already has, so provisioning takes milliseconds
  rather than the twenty seconds an install cost. The flip side is that a
  specialist cannot add a dependency: those commands are denied, because
  through the link they would rewrite your own `node_modules`.
- **Decisions, not transcripts.** Reports render as pages with numbered options.
  Press `1`–`n`, `Enter`. The answer goes back into the live session.
- **Intake.** A specialist can ask everything it needs at once, with its own
  picks pre-filled, so only the questions it genuinely cannot guess block it.
- **Progress you can read.** A live trail derived from tool calls — `Bash pnpm
  test`, `Edit src/registry.ts` — beside the specialist's own checklist.
- **They outlive the daemon.** Restart Bench and the roster comes back. Nothing
  respawns until you prompt it, and then it resumes with its memory intact.
- **Gates.** A commit carrying AI attribution is denied at `PreToolUse`. A
  specialist may not push a branch.

![The roster, grouped by project](docs/screenshots/roster.png)

## Running it

Requires Node 22+, pnpm, git, and the `claude` CLI already authenticated.

```bash
pnpm install
pnpm build
pnpm start
```

It prints a localhost URL with a token. Open it, and bookmark it — the token
is kept in `~/.bench/token` (mode `0600`) so the link keeps working across
restarts. Delete that file to rotate it. The daemon binds to `127.0.0.1` only
and every API route requires the token.

By default it looks for git repositories under `/var/www`. Point it elsewhere:

```bash
BENCH_PROJECTS_ROOT=~/code pnpm start
```

| Variable | Default | What it does |
|---|---|---|
| `BENCH_PROJECTS_ROOT` | `/var/www` | Where to look for projects |
| `BENCH_PORT` | `7420` | Cockpit port |
| `BENCH_HOME` | `~/.bench` | Where the specialist index and token are kept |
| `BENCH_TOKEN` | generated | Override the cockpit token |

Nothing hot-reloads yet: `pnpm build` before `pnpm start`, and run it from the
repository root.

## How it works

```
browser ──ws/http──> daemon ──stdin/stdout(stream-json)──> claude -p
                       │                                      │
                       ├── git worktree per specialist ───────┘
                       └── .bench/reports/<id>/  reports, replies, threads
```

A turn ends with a `result` event and the process blocks on stdin, so the turn
is the unit of control and no separate "needs input" protocol exists. Prompts
sent while a turn is running are held by the daemon, not written to stdin, so
they get a turn of their own instead of being swallowed by the one in flight.

Reports and replies are agent-authored HTML, rendered in a sandboxed frame
under a strict CSP: no network, no scripts, no external anything.

## Status

**[docs/STATUS.md](docs/STATUS.md) is the honest account** — what is built and
proven against a real CLI, what is built but unproven, what is broken, what was
deliberately left out, and the bugs found by using it. It is kept current
because it goes stale the moment the code moves.

Bench is early. It is used to build itself, which is where most of its bugs have
come from.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Two things worth knowing up front: tests
must run against the real CLI before a claim is called proven, and commits never
carry AI attribution — there is a gate that enforces it.

## Licence

MIT — see [LICENSE](LICENSE).
