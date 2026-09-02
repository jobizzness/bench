---
name: bench-roster
description: Use when the developer asks you to hand work to someone else - spin up an implementer, get a reviewer on it, put a researcher on a question - or when you need to know who else is working on this project.
---

# Opening a tab on the bench

You are one specialist on a bench of them. There is no tree: an implementer,
a reviewer and a researcher are all top-level, each with their own worktree,
branch and thread. The `bench` command is how you see them and how you open
a new one.

```
bench ls                            who is on this project, what model, and what they are doing
bench new <label> [--as <role>]     open a tab. It waits until you tell it what for
bench tell <label> "<text>"         give one its next turn
bench close <label>                 done with a sub-agent you opened - shut it down
bench restart [--build]             stop the daemon and start it again
```

`bench ls` and `bench new` both say what model a tab is on - see "What each
role opens on" below if you need to check or explain that to the developer.

Labels are lowercase words: `implementer`, `reviewer`, `payments-spec`.

## Giving it a role

The label names the work; `--as` is what actually assigns the role - the
model it opens on and the brief it runs under. They are separate on purpose:
`bench new reviewer` with no `--as` opens a specialist labelled "reviewer",
not a reviewer. Say the role you want:

```
bench new implementer --as implementer
bench new reviewer --as reviewer
bench new payments-spec --as planner
```

## What each role opens on

The role decides the model, not you - there is no `--model` flag on `bench
new`. A specialist you open with no `--as` and one you open `--as reviewer`
are not the same spend:

| `--as`        | Model                                    | Why                                              |
|---------------|-------------------------------------------|---------------------------------------------------|
| `specialist`  | Opus                                       | Owns the whole job, planning included.             |
| `planner`     | Opus                                       | Deciding what to build is the one place to spend the most. |
| `implementer` | Sonnet                                     | Flagship coding model, precise on the turn that must compile. |
| `reviewer`    | Gemini 2.5 Flash (Haiku with no OpenRouter key) | Reads a diff, not a conversation - huge context, near-zero cost. |
| `researcher`  | Gemini 2.5 Flash (Haiku with no OpenRouter key) | Reads a great deal and judges little.              |
| `assessor`    | Gemini 3.1 Pro (Opus with no OpenRouter key) | A flagship from a different house, on the end-to-end view. |

If a developer asks whether tabs are running on a given model, this table
and `bench ls`'s model column are how you answer it - not a guess.

If you were dispatched as one kind of subagent and are handing the same kind
of work to a bench tab, carry the role across rather than defaulting to
specialist:

| Subagent type                          | `--as`        |
|-----------------------------------------|---------------|
| `code-reviewer`                         | `reviewer`    |
| `code-architect`, `Plan`                | `planner`     |
| `code-explorer`, `Explore`              | `researcher`  |
| anything else (including `general-purpose`) | `specialist` |

## When to open one

**When the developer asked you to.** "Spec it and spin up an implementer" is
an instruction with two halves; do both.

Not because a task felt large. Every tab is a whole process, and deciding on
the developer's behalf that a job deserves three of them is spending their
money on your own judgement - even where the role is a cheap one (see "What
each role opens on"). If you think the work wants splitting and nobody has
said so, say so in your report and let them decide.

## Handing work over

A new tab opens empty and waits. What it is for is the first thing you tell
it, and that is `bench tell`.

Write the spec down first, then point at it. A path beats a paragraph: the
other specialist has a shell and can read the file, and a summary you type
into a prompt is a copy that starts going stale immediately.

```bash
bench new implementer --as implementer
bench tell implementer "The spec is at docs/specs/2026-08-23-payouts.md. \
Build what it describes. The open question in section 4 is the developer's, \
not yours - report rather than guessing it."
```

Then say in your own reply that you opened it and what you told it, so the
developer knows there is a new tab and does not find it by surprise.

## Closing one when you're done with it

Once a sub-agent you opened has reported back and you have what you needed,
close it rather than leaving it idle on the roster:

```bash
bench close implementer
```

This only works on a tab you opened yourself with `bench new` - not this one,
and not a tab the developer opened from the cockpit. If closing would destroy
uncommitted work, it says so instead of doing it; that decision goes to the
developer, not to you.

## Restarting Bench itself

If you have changed anything under `src/daemon`, the running daemon is still
the old build and will stay that way until it is restarted. That used to mean
asking the developer. It does not any more:

```bash
bench restart --build
```

You can run this safely from inside your own tab, even though stopping the
daemon stops every specialist including you. It waits until no turn is running
before it stops anything, so your turn finishes and is written down first.
What happens next is worth knowing rather than being surprised by: your tab
goes cold along with everyone else's, the roster comes back on the new daemon,
and nothing resumes until the developer prompts it. So say in your reply that
you restarted — the developer's next message is what brings you back, and they
should know why.

`--build` builds first and leaves the running daemon alone if the build fails.
Use it: restarting onto a build you have not run is how you find out your
change did not compile by having no cockpit.

Do not reach for this on every turn. It is for when you have actually changed
the daemon and need the change live — not for tidiness.

## Do not install dependencies

Your worktree's `node_modules` is a **symlink to the developer's checkout**,
not a copy of it. So `pnpm install` from in here does not install into your
worktree — it rewrites the tree that the developer and every other specialist
are reading through, and a half-finished one breaks all of them at once.

Nothing stops you. There used to be a blanket denial and it was removed,
because a refusal with no explanation just sent agents round it. This is the
explanation instead.

If you genuinely need a dependency, say so in your report and let the
developer add it. If you have already run an install and something looks
wrong, say that too — it is much cheaper to hear it from you than to find it
in somebody else's failing build.

## What it cannot do

Only this project. A tab somewhere else is the developer's call, made in the
cockpit — the same rule as sharing a report, and for the same reason: work is
about one codebase.
