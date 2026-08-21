# Bench — where it stands

Last updated 2026-08-21. 115 tests passing, 2 end-to-end suites run
separately against the real CLI.

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

**Chat, including mid-turn.** A message can be sent to a specialist and
answered in its own turn, whether the specialist is idle or working. A
message that arrives mid-turn is held by the daemon and only written to
stdin once the running turn ends — writing it earlier let the CLI feed it
to the turn already in flight, which is what [#1](https://github.com/jobizzness/bench/issues/1)
was. Verified against the real CLI: a message enqueued 700ms into a work
turn produced two turn ends, and the gate log shows turn 2 marked `chat`
and exempt.

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

**[#2](https://github.com/jobizzness/bench/issues/2) — a trivial task once
cost `num_turns=24`.** Not yet explained. What has been ruled out is the
issue's own hypothesis: the gate does not thrash. Instrumenting every hook
invocation against the real CLI shows it blocks at most once per turn —
once when the agent tries to finish without a report, then allowing the
retry — and in some runs not at all. The duplicate report directory in that
run was [#1](https://github.com/jobizzness/bench/issues/1), not retries: the
absorbed message carried its own `Turn 2. Write ... into .../2` framing and
the agent obeyed both instructions inside one turn. That half is fixed. The
24 turns were on a flagship model and have not been reproduced on a cheap
one, so the issue stays open with a corrected premise.

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

- **A message sent to a working specialist was never answered.** It was
  written to stdin immediately, framed for a turn that had not started; the
  CLI handed it to the turn already running, which absorbed it. Fixed by
  holding the queue in the daemon and dispatching only when the turn it
  belongs to begins. ([#1](https://github.com/jobizzness/bench/issues/1))
- **An end-to-end assertion was decided by the model's judgement.** The chat
  test asserted a chat turn creates no directory at all, while the reply
  skill tells that turn to write `reply.html` into one — so it passed only
  when the model chose prose. Now asserts what the contract actually says:
  no report.
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
