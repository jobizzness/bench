# Bench — where it stands

Last updated 2026-09-03. 1572 tests passing, 8 skipped (2 end-to-end
suites run separately against the real CLI, and a Firestore rules suite
run separately against the emulator), 4 failing and unrelated to anything
on this page — pre-existing, tracked as
[#50](https://github.com/jobizzness/bench/issues/50). A fifth failure appears
intermittently and is never a regression: it is the suite colliding with
another copy of itself, which happens whenever an agent runs the tests in its
worktree while you run them here
([#65](https://github.com/jobizzness/bench/issues/65)). Re-run it alone before
believing it.

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

A tab opened by another specialist is different: its first brief is held for
you to read, change the model on, and then dispatch or decline. That brief is
on disk (`SessionRecord.pendingDispatch`), so `bench restart` no longer
destroys it — it used to, silently, leaving the tab reading "ready" as though
it had never been given work at all
([#66](https://github.com/jobizzness/bench/issues/66)).

**A dropped read says so.** The thread and the plan tell "could not fetch it"
apart from "there is nothing there" — both used to arrive as empty, so a
missed read drew "Working. Nothing to read yet" over a long conversation and
asked the composer what the specialist was for. It keeps the last copy that
arrived and marks it stale. This matters because the relay genuinely drops
reads: the daemon log names connect timeouts, resets and DNS failures against
`firestore.googleapis.com`, several an hour from this machine
([#62](https://github.com/jobizzness/bench/issues/62)).

**A failed send says so.** The write-side counterpart to #62: `Queue.tsx` and
`PhoneUnblock.tsx` posted an answer inside `try { ... } finally { setBusy(false) }`
with no `catch`, so a POST that rejected — or came back with a bad status —
just un-disabled the button and said nothing. The developer had no way to
tell the answer from one that had actually gone, and nothing to retry: the
option and the typed text were never touched on failure, so they were still
there, but the screen gave no reason to look at them again. Both now show
"Didn't send" beside the option and text they left alone, and clear it on
the next attempt that lands — nothing here retries on its own.
`useReportFrame.ts` had the same shape one layer in: `void loadArtifact(...)
.then(...)` with no `.catch()` left a failed report load as an empty
bordered box forever, plus an unhandled rejection. It now says the load
failed instead
([#60](https://github.com/jobizzness/bench/issues/60)).

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

**A specialist answered by OpenRouter, end to end.** A specialist was created
through the cockpit on `google/gemini-2.5-flash-lite`, prompted, and replied —
the reply is in its thread. Before 26 August none could have:
`ANTHROPIC_BASE_URL` was set to `https://openrouter.ai/api/v1` and the CLI
appends `/v1/messages` to it, so every request went to `/api/v1/v1/messages`,
got a 404 HTML page, retried seven times and died. Both halves are now checked
against the live service with a real key: the old URL still answers 404, the
new one answers 200.

It survived 1002 tests because the test compared `sessionEnv()` against a copy
of the same constant that fed it, which is true of any value. The tests now
assert the URL the CLI actually resolves.

**The OpenRouter credit meter, on a real key.** The success shape — the `usage`
and `limit` fields — could previously only be read from a stub. That one turn
moved the meter from `$0.00` to `$0.0045`, which is the field coming from
OpenRouter rather than from a fixture.

**The parked switch, across a restart.** The switch beside the Anthropic key
means "bill this to the login this machine already has". It lasted exactly as
long as the daemon, which was harmless while the key was forgotten at the same
moment — a bench with no key has nothing to park. Reading keys from a `.env`
broke that: the key came back and the decision not to spend it did not, so a
parked key was quietly billing the API again after a restart. The flag is now
written to `~/.bench/keys.json` — the flag only, never the key. Verified by
parking a key, restarting the daemon, and finding it still parked; and the
other way round.

**Keys Bench finds for itself.** Both keys are read at startup from the
environment or a `.env`, and reported with where they came from. Verified by
starting a daemon against this repo's own file: both were picked up, including
the non-standard `OPEN_ROUTER_KEY` spelling, and the OpenRouter one is what the
turn above was billed to. The file is read rather than merged into the
environment, so the OpenAI and Gemini keys sitting beside them in that file
reach no specialist.

## Built, not yet proven in anger

- **Bench from a phone** — all three slices of the
  [Firestore design](superpowers/specs/2026-08-31-bench-over-firestore-design.md)
  are merged and the cockpit is deployed at `bench-cockpit.web.app`.

  *Identity* ([#45](https://github.com/jobizzness/bench/issues/45)): "Turn on
  remote" in Settings signs in with Google and hands the daemon the refresh
  token, which it keeps at `~/.bench/firebase.json` mode `0600` and trades for
  an hour-long ID token at `securetoken.googleapis.com` directly. No Firebase
  SDK on the daemon side at all — only the browser bundle imports
  `firebase/auth`, for `signInWithPopup`.

  *The wire* ([#46](https://github.com/jobizzness/bench/issues/46)): a
  specialist is **broadcast**, deliberately, from its own page; nothing else
  leaves the machine. Actions become command documents the daemon executes
  against its own loopback server; watched state becomes a mirror it pushes.
  Both gates compose — the mirror is `broadcast ∧ watched` — so with nothing
  broadcast the daemon touches Firestore not at all.

  *The phone* ([#47](https://github.com/jobizzness/bench/issues/47)): below
  720px the cockpit shows one pane at a time, driven by the `selectedId` the
  URL already carries, so the phone's own back gesture works without new
  state. Decision options stack to 44px targets; the keyboard hints hide.

  *The phone, redesigned* ([#57](https://github.com/jobizzness/bench/issues/57),
  reversed by [#83](https://github.com/jobizzness/bench/issues/83)): #47 made
  the layout fit a phone; #57 made it open on whatever was waiting instead of
  on a roster you would then have to navigate out of. That read fine in
  review and wrong from a real phone — opening straight onto a report with no
  sense of what else exists reads as being dropped somewhere, not arriving
  somewhere — so #83 put the roster back as the front door, on a phone the
  same as everywhere else. Something waiting is still unmissable there:
  `.row[data-waiting="true"]` carries a tinted background and a rail (louder
  still since #79's crossing animation), so it is *shown*, not navigated to.
  Tapping a waiting row still opens the unblock screen — the report rendered
  inline (the iframe reads its own content height on load and resizes to it,
  so it scrolls as one column with the decision's options rather than in a
  little window of its own) and answerable without leaving it — and
  answering one still moves straight to the next waiting decision rather
  than detouring back through the roster; both of those are the part of #57
  that was right and #83 keeps. An intake is handed over to the ordinary
  stage instead of forced into the single column, since it wants the whole
  page (`Queue.tsx` already made the same call). The one piece of this that
  is not just CSS — `usePhoneLanding.ts` reading `selectedId` and steering
  `pane` off of it — is gated on a real `matchMedia` check rather than the
  stylesheet's breakpoint, so opening the app above 720px never touches who
  is selected. The roster row composition from the #57 ticket — one right
  edge instead of three, the drag grip gone below the breakpoint, bigger
  type — is unaffected and stays.

  **What has never happened: a phone has never driven a specialist.** Every
  part of the transport is proven against a fake Firestore, and the identity
  half has been signed into for real — but no command document has ever been
  written by a real browser, no mirror has been read on a real network, and
  the soft-keyboard behaviour is simulated rather than checked. Two machines
  under one account is likewise unproven; it needs a second laptop.
  [#55](https://github.com/jobizzness/bench/issues/55) is that list.

  One design decision worth knowing rather than rediscovering: the daemon
  **polls** rather than holding a listener. Firestore's SDK takes its token
  from a component only `firebase/auth` registers, and `firebase/auth` cannot
  be signed in from a stored refresh token in Node. Both ways round it rest on
  parts of Firebase whose versioning policy excludes them. Broadcast is what
  makes polling affordable.
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
- **Changing a specialist's model mid-life.** Recorded, and the process is
  let go so the next prompt revives it on the new model resuming the same
  transcript. That path is the one a cold specialist already takes after
  every daemon restart, which is why it is built this way — but the
  Anthropic-to-OpenRouter direction has not been walked with a real CLI.

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
- **Every restart silently logged you out.** The cockpit token was minted
  fresh on each boot, so any open tab or bookmark stopped working — and
  nothing said so: the page still served, the websocket was refused with
  1008, and the client treated that like a dropped connection and retried
  forever. The result was an empty roster that read as "all my specialists
  are gone" while they sat safely in the index. The token now persists in
  `~/.bench/token`, and a refused socket says the link is stale instead of
  retrying in silence.
- **Two jsdom suites went from green to two thirds skipped between runs.**
  Moving the roster into React made their `beforeAll` depend on a fixed 10ms
  delay for a mount that flushes across scheduler turns, and a `beforeAll`
  that throws skips its whole suite rather than failing it — so the run
  stayed green-looking while covering less and less. They wait on the
  condition now.
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
- [`specs/2026-08-31-bench-over-firestore-design.md`](superpowers/specs/2026-08-31-bench-over-firestore-design.md) — reaching the daemon from a phone: identity, the wire, the mobile layout
- [`plans/`](superpowers/plans/) — the implementation plans both were built from
