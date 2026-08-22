# Bench — where it stands

Last updated 2026-08-22. 127 tests passing, 2 end-to-end suites run
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

**Reports, written when the agent judges one is warranted.** There is one
kind of turn. Nothing declares a prompt "work", and nothing blocks at
`Stop`: the specialist decides whether a turn earned a report — a decision
that needs you, finished work you have to understand, a spec to approve, or
being stuck — and otherwise just replies. Verified against the real CLI:
a trivial question produced a reply and no report, an explicit piece of
work produced `report.html` and `decision.json`.

This replaced a gate that blocked every work turn at `Stop` until a report
existed. The gate did what it claimed — an agent told only to "say done"
was forced to produce a report it was never asked for — but forcing the
artifact is not the same as earning it, and it charged a flagship model for
paperwork on trivial turns. The same trivial prompt now costs 11s instead
of 49s.

**The attribution gate.** A `git commit` carrying `Co-Authored-By: Claude`
or a "Generated with" footer is denied at `PreToolUse`. It matches
trailers, not the word — a commit documenting `CLAUDE.md` passes.

**Worktree bootstrap on a real Prisma repo.** Against teledoctor: worktree
created, 1.2G of dependencies installed, `.env` symlinked to the main
checkout rather than copied, correct branch, and the main working tree left
clean.

**Specialists outlive the daemon.** A small index at `~/.bench/sessions.json`
records each specialist; threads and reports already live with the project
and the worktree is on disk. On boot the roster comes back and **nothing is
spawned** — a cold specialist costs nothing, and the developer may only want
to read what it already wrote. The first prompt revives it with `--resume`,
so it comes back knowing what it was doing. Verified by killing the daemon
outright: roster and thread restored, no `claude` process running, and on
the next prompt the specialist recalled a codeword from before the restart.

**Prompting, including mid-turn.** A specialist is created empty and waits;
what it is for is the first thing you type at it, not a field in a dialog.
A prompt that arrives mid-turn is held by the daemon and only written to
stdin once the running turn ends — writing it earlier let the CLI feed it
to the turn already in flight, which is what [#1](https://github.com/jobizzness/bench/issues/1)
was. Verified against the real CLI: a prompt enqueued 700ms into a running
turn produced two turn ends rather than one.

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

**Provisioning assumes a Node project.** A repo with no `package.json`
fails bootstrap at the install step, and the failure surfaces as
`install:` with an empty message — the stderr is not captured. Bench is
usable only on repos it knows how to install.

## Deliberately not built

**Two-phase permission mode.** The spec has a Specialist start in
`--permission-mode plan` so it cannot edit before you approve its spec,
then resume into `acceptEdits`. Both halves are verified to work —
`--resume` preserves full context across a mode switch, and plan mode
genuinely refuses to write — but it is not wired up. Specialists currently
run in `acceptEdits` for their whole life. What is missing is the
guarantee that nothing was edited before you said yes. This is the first thing worth restoring.

**The fleet.** Real port allocation (currently `3100 + session count`), the
sub-agent tree, a decision queue, the migration lock that stops two agents
running Prisma migrations against the same dev database, and cross-worktree
write denial. The last one has already bitten: a specialist editing
`src/client/` on its own branch while the same files were being changed on
`main` is a merge conflict nobody is warned about.

## Bugs found by using it

Worth recording, because none were caught by tests.

- **A restored specialist was refused its own first prompt.** The message
  route rejects a session whose process is not alive, which is exactly the
  state a specialist restored from disk is in — so reviving it was blocked
  by the guard meant for crashed ones. Cold is not dead; the registry now
  distinguishes them. Found by restarting the daemon and trying it, minutes
  after the unit tests for restore went green.
- **Specialists could write code and never run it.** `--permission-mode
  acceptEdits` auto-accepts edits and nothing else, and a `-p` session is
  non-interactive, so every `pnpm build`, `pnpm test` and `npx tsc` was
  refused outright with no prompt to answer. A specialist could not compile
  or test a single line it wrote — while the report it is asked to produce
  is built around a Verified list. `buildSettings` now allows the common
  toolchain, and denies `git push`: publishing a branch is not a build step.
  Hooks are evaluated regardless of permissions, so the attribution gate
  still denies an AI-attributed commit the allowlist would otherwise permit
  — verified against the real CLI.
- **Reports were written where the specialist was not allowed to write.**
  The reports directory lives with the project so it outlives the worktree,
  which put it outside the session's workspace: every `report.html` was
  refused with *"Claude requested permissions to write to … but you haven't
  granted it yet"*, and specialists quietly fell back to `/tmp`. The roster
  showed no report waiting while a finished 13KB report sat on disk. Fixed
  by passing `--add-dir` for the reports directory.

  Worth its own line: **the test suite could not have caught this.** Every
  test builds its fixtures with `mkdtemp(tmpdir())`, and writes under `/tmp`
  are permitted where writes elsewhere are not — so the end-to-end test
  passed against a path that could never fail. It now runs outside `/tmp`,
  where the refusal actually reproduces.
- **Creating a specialist demanded a task before it existed.** The New
  Session dialog asked what the specialist was for, so the first prompt was
  buried in a form rather than typed at it — and `create()` never wrote that
  task to the thread, so the cockpit showed an empty conversation beside a
  specialist burning Opus tokens. The field is gone; a specialist opens
  empty and waits to be told.
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
