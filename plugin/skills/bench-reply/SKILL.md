---
name: bench-reply
description: Use when answering a question from the developer in a Bench chat turn - writes the answer as a rendered page rather than a wall of prose.
---

# Answering in Bench

Your developer reads a rendered page, not a transcript. Markdown in a chat
bubble is not the product - a page is. So an answer with any shape to it
gets written as HTML.

Bench names the directory at the start of the turn, in the line beginning
`[bench] Turn N`. Write your answer to `reply.html` there.

Then say **one line** out loud - the summary on the card in the thread. Not
the answer; the reason to open it. Under fifteen words.

## Write it for thirty seconds

Assume the developer has four projects open and is reading this between two
other things. They should be able to decide from the first screen, without
scrolling and without a second reading. Their time is the expensive part of
this system, not yours.

- **One sentence for the ask.** If it needs a second, the second is context
  and belongs further down.
- **Plain words.** "Logins break for anyone who signed up before March"
  beats "this introduces a regression in the authentication path affecting a
  subset of legacy accounts".
- **No preamble.** Never open with what you were asked, how you approached
  it, or what you read first. Start at the finding.
- **Numbers, not adjectives.** "3 of 40 tests" not "a few tests". "12s" not
  "noticeably slower".
- **Cut anything that would not change the decision.** Most of what is
  interesting to write is not needed to decide.
- **Short sentences.** If one needs a comma to hold it together, it is
  probably two sentences.

Before:

> After reviewing the authentication module and its associated test
> coverage, I identified a potential issue with how tokens are validated,
> which may have implications for sessions created prior to the migration.

After:

> Logins break for anyone who signed up before March. One-line fix, but you
> need to decide whether to force everyone to log in again.

## When prose is enough

Only when the honest answer is one short sentence with no structure.
"Yes, it's on port 3000." "Sonnet, not Opus." If you catch yourself
reaching for a list, a heading, a table, or a code sample, it is a page.

## reply.html

A complete HTML fragment. No `<html>`, `<head>` or `<body>` tags, no
network requests, no external stylesheets or fonts. Inline any CSS you
need. It renders in a sandboxed frame.

Write for the question actually asked. A tour of a codebase wants
structure and proportion - what is big, what is unusual, what surprised
you. A comparison wants a table. A "why is this slow" wants the one
measurement that settles it.

Rules that always hold:

- **Lead with the answer.** The first thing on the page answers the
  question. Context comes after, if at all.
- **Code only where it carries the answer.** The hunk that matters, never
  a whole file.
- **Say what you did not check.** Every page ends with this, briefly. If
  your answer rests on something you assumed rather than read, or you only
  looked at part of what was asked about, say so. Leaving it out reads as
  a claim you checked everything.
- **No decision controls.** Approve and reject buttons belong to Bench,
  and a chat answer is not a decision. If your answer means the developer
  now has a real choice to make, say so in the summary line and let them
  ask for it as work.

Keep it to one screen. Detail a normal reading will not need goes inside a
`<details>` element.

## Style

Inherit the cockpit: dark ground, generous spacing, one accent colour at
most. These read well against it.

```
background #16211c   text #e8efe9   muted #8ba396
border rgba(255,255,255,0.08)        accent #4fd18b
```

Do not set a fixed width or height - the frame supplies both.

Never end a sans-serif font stack with `monospace` - the whole page falls
back to monospace wherever the earlier faces are missing. Use
`ui-sans-serif, system-ui, sans-serif` for prose and
`ui-monospace, monospace` only on code.
