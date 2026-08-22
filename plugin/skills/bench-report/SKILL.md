---
name: bench-report
description: Use when a decision needs the developer, when work is finished and they need to understand what it means, when a spec needs approving before you build, or when you are stuck - writes the report page and decision they read to make the call.
---

# Writing a Bench report

Your developer does not read your transcript. They read one page and press
one key. That page is the entire interface between your work and their
decision, so it is written for deciding, not for narrating.

## When to write one

Nobody tells you a turn is "work". You decide. Write a report when one of
these is true, and not otherwise:

- **A decision needs them.** You have hit a fork you should not settle
  alone, and the choice has consequences they own.
- **The work is done and they need to understand it.** The closing summary
  on a piece of work, the way an issue gets closed - what changed, what it
  means, what you did not verify.
- **A spec needs approving.** You have worked out how you intend to do
  something and want a yes before you build it.
- **You are stuck.** You cannot make progress and need help. Say so
  plainly; a report that admits this is worth more than one that pretends.
- **You have just been told what to build and it is ambiguous.** Read the
  code first, then write an *intake* — see below. This is the common case:
  most tasks arrive underspecified, and the cheapest moment to find out is
  before the first edit.

Everything else - answering a question, reporting a small step, thinking out
loud - is just your reply. Do not manufacture a decision to have something
to put in `decision.json`. A turn that needed no report and produced none is
a normal turn.

## Where it goes

Bench names your report directory at the start of every turn, in the line
that begins `[bench] Turn N`. Write both files there:

- `report.html` - what you did and what it means
- `decision.json` - the question you need answered

## report.html

A complete HTML fragment. No `<html>`, `<head>` or `<body>` tags, no
network requests, no external stylesheets or fonts. Inline any CSS you
need. It is rendered inside a sandboxed frame.

Required sections, in this order:

**1. The ask.** The first thing on the page is what you need decided and
why it matters. Not what you were assigned, not how you approached it.

**2. What changed.** In the application's terms, not the filesystem's.
"Password reset now expires tokens after one use" - not "modified
`auth.ts`, `tokens.ts`, `mailer.ts`".

**3. Evidence, only where the decision hinges on it.** A diff hunk of the
five lines that matter, never a whole file. If the developer does not need
to read code to decide, include none.

**4. Verified / Not verified.** Two explicit lists. Under *Verified*: what
you actually ran, with the command and its result. Under *Not verified*:
what you assumed, could not test, or ran out of scope to check. This is the
most valuable section on the page. An empty *Not verified* list is almost
always a lie - if you genuinely verified everything, say what would break
the verification.

**5. What you would do next** if the answer is simply "go".

Keep it to what fits on two screens. Use headings, short paragraphs and
tight lists. Detail that most readings will not need goes inside a
`<details>` element.

## decision.json

```json
{
  "kind": "spec_approval",
  "title": "Token expiry strategy for password reset",
  "summary": "Single-use tokens work, but the expiry window is your call.",
  "options": [
    { "id": "15m", "label": "15 minute expiry", "hint": "Matches the login OTP." },
    { "id": "1h", "label": "1 hour expiry", "hint": "Kinder on slow email delivery." }
  ],
  "allowFreeText": true
}
```

- `kind` - `spec_approval` when you need a plan approved before building,
  `question` when you are blocked mid-work, `completion` when work is done
  and needs review, `intake` when you have several questions at once and are
  about to start. An `intake` uses `questions` instead of `options`; the
  shape below is for the other three.
- `title` - a short noun phrase naming the decision.
- `summary` - one sentence. It is what the developer sees in the roster
  before opening the page.
- `options` - the concrete choices. Two to four. Each `hint` states the
  consequence of choosing it, not a restatement of the label. Omit or leave
  empty when there is nothing to choose between and you only need a reply.
- `allowFreeText` - keep `true` unless a free-text answer would be
  meaningless.

## The intake — asking before you build

When a task arrives underspecified, do not ask one question, wait, and then
ask the next. Read the code, work out *every* question the task actually
raises, answer as many of them as you honestly can, and put the whole set on
one page. `kind` is `"intake"` and the questions go in `questions`.

The rule that makes this work: **answer your own questions first.** Mark your
pick with `"default": true`. Anything the developer does not touch comes back
as your answer, labelled as unreviewed — so a question you can guess costs
them nothing, and the only ones that block are the ones you left with no
default. Leave a default off when you genuinely cannot guess, and only then.
An intake where nothing is defaulted is an interrogation, and you have simply
moved your job onto the person who asked.

```json
{
  "kind": "intake",
  "title": "Password reset — before I build",
  "summary": "Six questions, four I've answered. Two want you.",
  "brief": "Reset links expire after {expiry}, are single-use, and cover {flows}. Requests are {ratelimit}.",
  "questions": [
    {
      "id": "expiry",
      "ask": "How long should a reset token live?",
      "why": "Sets the email copy and whether the cleanup job needs a schedule.",
      "stakes": "high",
      "select": "one",
      "options": [
        { "id": "15m", "label": "15 minutes", "hint": "Matches the login OTP." },
        { "id": "1h", "label": "1 hour", "hint": "Kinder on slow mail; wider window to steal a link." }
      ],
      "allowFreeText": true
    },
    {
      "id": "flows",
      "ask": "Which entry points get it?",
      "stakes": "high",
      "select": "many",
      "options": [
        { "id": "web", "label": "Web sign-in", "default": true },
        { "id": "mobile", "label": "Mobile app", "hint": "Needs a deep link I'd have to add." }
      ]
    },
    {
      "id": "ratelimit",
      "ask": "Rate limit the request endpoint?",
      "stakes": "low",
      "options": [
        { "id": "reuse", "label": "reuse the existing limiter", "default": true },
        { "id": "none", "label": "not rate limited" }
      ]
    }
  ]
}
```

- `ask` — the question in one line, in the application's terms.
- `why` — what swings on the answer. Not a restatement of the question.
- `stakes` — `high` shows the question open; `low` folds it into a single
  summary line the developer can expand. Anything you left undefaulted stays
  open whatever you put here. Be honest: an intake where everything is `high`
  is as unreadable as one long list, which is the thing this replaces.
- `select` — `one` or `many`. Use `many` where "both" is a real answer;
  forcing it through one-of-N is how a wrong answer gets recorded.
- `brief` — one sentence saying what you will build, with `{questionId}`
  holes. Bench fills them live as the developer flips answers, so they read
  the consequence instead of the label. Reference the questions that change
  the shape of the work; you do not need all of them. **Every option label
  you reference has to read as a fragment of that sentence**, because it is
  dropped in verbatim: `"resets {audit} to the audit trail"` with a label of
  *"Yes, log every reset"* produces *"resets Yes, log every reset to the
  audit trail"*. Name the option *"go to"* — or leave that question out of
  the brief. Read the sentence back with each label in it before you write
  the file.
- `report.html` still comes first and still matters: it is where you show
  what you read, what you found, and why these are the questions.

The developer's reply tells you which of your answers they actually looked
at. Treat an unreviewed default as your own assumption, not as their
instruction — if one of them turns out to be load-bearing later, that is
worth a second report, not a silent decision.

## Rules

- Never put approve or reject buttons in `report.html`. The decision
  controls are Bench's, and they are the same on every report so the
  developer builds muscle memory.
- Write `decision.json` last. Bench treats `report.html` as the signal that
  a report is ready.
- One report per turn. Write it and end your turn - Bench delivers the
  answer as your next message.
