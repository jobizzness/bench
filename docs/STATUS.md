# Bench — where it stands

Last updated 2026-08-21. 37 commits, 114 tests passing, 2 end-to-end suites
run separately against the real CLI.

Bench supervises Claude Code specialists running in WSL and surfaces their
work as decision-shaped pages served on localhost. This is an honest
account of what is built, what has actually been proven, and what is
broken.

## Built and proven

Each of these was verified against a real `claude 2.1.238` process, not
only unit tests.

**The session loop.** A Specialist is one long-lived `claude -p` process
speaking stream-json in both directions. A turn ends with a `result` event
and the process blocks on stdin, so the turn is the unit of control and no
separate "needs input" protocol exists. Verified by running one.

**The report gate.** A Specialist cannot end a work turn without writing a
report. Proven the hard way: an agent told only to "say done" was blocked
at `Stop` and forced to produce `report.html` and `decision.json` it was
never asked for.

**The attribution gate.** A `git commit` carrying `Co-Authored-By: Claude`
or a "Generated with" footer is denied at `PreToolUse`. It matches
trailers, not the word — a commit documenting `CLAUDE.md` passes.

**Worktree bootstrap on a real Prisma repo.** Against teledoctor: worktree
created, 1.2G of dependencies installed, `.env` symlinked to the main
checkout rather than copied, correct branch, and the main working tree left
clean.

**Chat.** A message can be sent to a specialist and answered. Mid-turn
input queues rather than being dropped — verified by writing a second
message 800ms into a running turn and watching both turns complete in
order.

**Reply artifacts.** A chat answer with any structure comes back as a
rendered page, not prose. Verified: a specialist wrote a 3127-byte
fragment and spoke a one-line summary, unprompted beyond the skill.

## Built, not yet proven in anger

- **The decision loop end to end through the browser.** Answers post back
  into the live session and the mechanics are tested, but nobody has yet
  run a real task to completion and answered it from the cockpit.
- **Concurrency.** Three specialists have run at once without incident.
  That is an observation, not a test.

## Known broken

Both filed, both reproducible.

**[#1](https://github.com/jobizzness/bench/issues/1) — a message to a
*working* specialist is absorbed, not answered.** The report gate blocks
the running turn at `Stop`, the conversation continues through that block,
and it swallows the queued message. No separate reply is produced. Talking
to an idle specialist works correctly.

**[#2](https://github.com/jobizzness/bench/issues/2) — the gate causes
turn thrashing.** A task whose honest answer is one sentence produced
`num_turns=24` and two report directories. Expensive on a flagship model.
Every existing test asserts only that a report exists, so none of them
catch a gate that gets there through twenty retries.

## Deliberately not built

**Two-phase permission mode.** The spec has a Specialist start in
`--permission-mode plan` so it cannot edit before you approve its spec,
then resume into `acceptEdits`. Both halves are verified to work —
`--resume` preserves full context across a mode switch, and plan mode
genuinely refuses to write — but it is not wired up. Specialists currently
run in `acceptEdits` for their whole life. The report gate still holds;
what is missing is the guarantee that nothing was edited before you said
yes. This is the first thing worth restoring.

**The fleet.** Real port allocation (currently `3100 + session count`), the
sub-agent tree, a decision queue, the migration lock that stops two agents
running Prisma migrations against the same dev database, and cross-worktree
write denial.

## Bugs found by using it

Worth recording, because none were caught by tests.

- **A queued message silently disabled the report gate.** Turn markers
  advanced when a message was *enqueued* rather than when its turn *began*,
  so a chat message relabelled the running work turn as chat and its `Stop`
  hook skipped the report. Fixed; markers now advance at turn start.
- **`is_error` was checked nowhere.** A failed turn presented as "waiting
  on you" with nothing to read.
- **The build served stale files.** `cp -r src/client dist/client` nests
  into `dist/client/client` when the target exists, so a successful build
  kept serving the previous UI.
- **A long reply pushed the composer off screen.** A flex child inside a
  grid item needs `min-height: 0`.
- **Bench committed its own worktrees.** `excludeBenchDir` covered
  `.bench/` but not `.claude/worktrees/`, so any repo not already ignoring
  `.claude/` picked them up as gitlinks.

## Running it

```bash
pnpm install
pnpm build
pnpm start
```

Prints a localhost URL with a token. Open it from Windows — WSL2 forwards
localhost.

Two things that bite: nothing hot-reloads, so `pnpm build` before every
start; and the daemon must be launched from the repo root.

## Design documents

- [`specs/2026-08-21-bench-design.md`](superpowers/specs/2026-08-21-bench-design.md) — architecture, gates, the report contract
- [`specs/2026-08-21-bench-conversation-design.md`](superpowers/specs/2026-08-21-bench-conversation-design.md) — turn kinds, the thread, the cockpit
- [`plans/`](superpowers/plans/) — the implementation plans both were built from
