# Bench — where it stands

Last updated 2026-08-22. 172 tests passing, 2 end-to-end suites run
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

**Closing a specialist, permanently.** A specialist can be closed from the
roster: the process stops, the git worktree and its branch are removed, and
the record is deleted — and the record is what boot reads, so it stays gone.
The thread and any reports are kept; they are small and they are what
actually happened. Closing refuses when the worktree holds uncommitted
changes or commits that exist on no other branch, and says how many, so
forcing it is a decision rather than an accident. Verified against real
repositories: a clean specialist closed and took its branch with it, one
with a single uncommitted file was refused, and forcing removed it.

**Seeing where a specialist has got to.** Two views of a running turn. The
activity trail is derived from tool calls — `Bash node test.js`, `Edit
src/daemon/registry.ts`, with repeats collapsed to `(×3)` — and is stamped,
so a long turn reads differently from a wedged one. The plan is the
specialist's own checklist at `plan.json` in the turn's directory, which the
framing asks it to keep current since this CLI gives it no todo tool; the
cockpit renders it as todo/doing/done. The trail cannot lie and the plan
says intent, which is why both are shown. Verified live: a four-step task
advanced its checklist through each step while the trail recorded what
actually ran.

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

**The intake.** A specialist told to build something underspecified asks
everything at once instead of one question at a time, and answers as many of
its own questions as it honestly can. Its picks arrive pre-selected and
marked *mine*; untouched questions come back as its answer, labelled
unreviewed, so an assumption nobody read stays visibly an assumption. Only
the questions it left undefaulted block sending, and those lead the list
because the panel scrolls. It writes a one-sentence brief with
`{questionId}` holes that the cockpit fills live as options are flipped.
The panel itself is verified two ways: 28 tests drive the real `app.js` in
a DOM, and it was rendered headless in Chrome and looked at — which is how
the blocking-question-below-the-fold problem was found, and the collision
with the progress panel after that.

**Reports open as pages.** A report card is a door, not a drawer: clicking
it opens the report in a dialog with the thread dimmed behind, rather than
unfolding a document inside a 108ch column. Replies keep their inline
preview — a reply is the answer to something you asked, and reading it
should not cost a click.

## Built, not yet proven in anger

- **The decision loop end to end through the browser.** Answers post back
  into the live session and the mechanics are tested, but nobody has yet
  run a real task to completion and answered it from the cockpit.
- **A specialist has never written an intake.** The skill says how; whether
  a real run produces sane `default` flags, honest `stakes`, and option
  labels that read as fragments of its own brief is unproven. Model
  compliance is the risk here, not the schema — a malformed intake already
  degrades to free text rather than wedging the session.
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

- **`hidden` did not hide.** The UA rule for `[hidden]` is `display: none`
  at the weakest possible weight, so every `#id { display: flex }` in
  `styles.css` silently outranked it — meaning the stage header and the
  working indicator have never actually hidden, in any build. One global
  rule fixes all of them, and every element added since inherits the fix.
- **A roster tick threw away whatever had been chosen.** `loadDecision`
  refetched and reset on *every* websocket push, so the selected option was
  discarded several times a second. Survivable while the loss was one radio
  button; not once it is half an intake. It now reloads only when a
  different report is on the table.
- **Two panels each capped politely, and together left nothing.** The
  progress panel takes up to 40vh and the intake up to 52vh; neither is
  wrong alone, and stacked they squeezed the thread to a 45px sliver with
  the report card clipped to a line. They now yield only when both are on
  screen. Neither test suite could have caught it — jsdom does not lay out —
  and it was found by rendering the merged tree in Chrome. It is also the
  first real instance of the cross-worktree collision predicted above: two
  sessions changed `src/client/` on separate branches, and the conflict git
  reported was one line, while the conflict that mattered was invisible to
  it.

- **The roster said "Bash" for twelve minutes.** `activityLine` returned the
  tool's name and discarded its input, so a specialist thinking hard and one
  that had wedged rendered identically — the only way to tell them apart was
  reading the process tree and diffing the CLI transcript by hand. It now
  says what the tool is doing, and each entry is stamped.
- **A specialist's label was being used as its identity.** The worktree and
  branch were named `worktree-<label>`, so two specialists could never share
  a label in one repo, and a branch left behind by a specialist Bench no
  longer knew about held that name forever — provisioning failed with raw
  git stderr in the roster and no way forward but renaming. The session id
  now names both, with the label kept in front so `git branch` still reads
  well: `bench/general-698353db`. The branch is recorded rather than derived,
  because guessing it is how the wrong branch gets deleted.
- **Every worktree looked like it had unsaved work.** Bench installs into
  each worktree it creates, so `node_modules/` and a generated lockfile sit
  there untracked. The first close refused on a specialist that had done
  nothing at all, counting Bench's own leavings as the developer's work. A
  guard that always fires is no guard, so untracked bootstrap artifacts are
  now forgiven — while a lockfile the repo actually tracks shows as modified
  and still counts. Found on the first live close, not by the tests.
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
