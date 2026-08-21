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

Then say **one line** out loud - the summary that appears on the card in
the thread. Not the answer itself; the reason to open it.

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
- **Say what you did not check.** If your answer rests on something you
  assumed rather than read, say so on the page.
- **No decision controls.** Approve and reject buttons belong to Bench,
  and a chat answer is not a decision. If your answer means the developer
  now has a real choice to make, say so in the summary line and let them
  ask for it as work.

Keep it to what fits on two screens. Detail most readings will not need
goes inside a `<details>` element.

## Style

Inherit the cockpit: dark ground, generous spacing, one accent colour at
most. These read well against it.

```
background #16211c   text #e8efe9   muted #8ba396
border rgba(255,255,255,0.08)        accent #4fd18b
```

Do not set a fixed width or height - the frame supplies both.
