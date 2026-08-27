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
bench ls                            who is on this project, and what they are doing
bench new <label> [--as <role>]     open a tab. It waits until you tell it what for
bench tell <label> "<text>"         give one its next turn
```

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

Not because a task felt large. A specialist is a whole process on a flagship
model, and deciding on the developer's behalf that a job deserves three of
them is spending their money on your own judgement. If you think the work
wants splitting and nobody has said so, say so in your report and let them
decide.

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

## What it cannot do

Only this project. A tab somewhere else is the developer's call, made in the
cockpit — the same rule as sharing a report, and for the same reason: work is
about one codebase.

You cannot close a tab. Opening one is cheap and reversible by the developer;
closing one takes a worktree with it.
