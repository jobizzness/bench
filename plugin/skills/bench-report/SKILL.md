---
name: bench-report
description: Use when you have finished a piece of work or produced a spec that needs approval - writes the report page and decision the developer reads to make a call.
---

# Writing a Bench report

Your developer does not read your transcript. They read one page and press
one key. That page is the entire interface between your work and their
decision, so it is written for deciding, not for narrating.

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
  and needs review.
- `title` - a short noun phrase naming the decision.
- `summary` - one sentence. It is what the developer sees in the roster
  before opening the page.
- `options` - the concrete choices. Two to four. Each `hint` states the
  consequence of choosing it, not a restatement of the label. Omit or leave
  empty when there is nothing to choose between and you only need a reply.
- `allowFreeText` - keep `true` unless a free-text answer would be
  meaningless.

## Rules

- Never put approve or reject buttons in `report.html`. The decision
  controls are Bench's, and they are the same on every report so the
  developer builds muscle memory.
- Write `decision.json` last. Bench treats `report.html` as the signal that
  a report is ready.
- One report per turn. Write it and end your turn - Bench delivers the
  answer as your next message.
