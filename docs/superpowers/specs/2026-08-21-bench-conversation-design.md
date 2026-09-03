# Bench conversation and cockpit — design

Status: approved design, pre-implementation. Written 2026-08-21.
Supersedes the client design in `2026-08-21-bench-design.md` §"Reports and
the decision loop" as it applies to the UI; the report contract itself is
unchanged.

## Why

Slice 1 proved the machinery and left the product wrong in one specific
way: there is no way to talk to a specialist. You can answer a decision it
raises, and nothing else. A specialist you cannot ask a question of is a
batch job with a nicer output format.

This design makes the specialist something you converse with, and reshapes
the cockpit around that.

## What was verified before designing

Two facts were established empirically against `claude 2.1.238`, not
assumed.

**Mid-turn input queues rather than being dropped.** Writing a second user
message to stdin 800ms into a running turn produced two results in order:
the first turn completed normally, then the queued message was processed as
the next turn. Chat is therefore possible.

**You cannot interrupt, only queue.** The queued message is not delivered
until the current turn ends. A question asked of a busy specialist waits
for it to finish. No UI hides this, so the roster has to explain it.

## The turn kind problem

The `Stop` gate refuses to let a Specialist end a turn without writing a
report. That is correct when every turn is work. It makes chat impossible:
asking "why Zod?" would force a full report with a `decision.json` for a
one-line answer.

Turns therefore have a kind, written by the daemon next to the existing
`.turn` marker:

| Kind | Set when | Report gate |
|---|---|---|
| `work` | you start a task, or answer a decision | enforced |
| `chat` | you send a message through the composer | exempt |

**The developer's action sets the kind. The agent never chooses it**, so a
specialist cannot talk its way out of reporting.

Only the report requirement lifts on a chat turn. The commit-attribution
gate and every other gate stay live on both kinds — a chat turn is not a
privileged turn.

### Why the gate is not otherwise loosened

Reports are for big decisions, summaries of finished work, and genuinely
complex things — never status pings. That might suggest the gate should
fire less often. It should not, because in stream-json mode **ending a turn
is the act of asking for the developer**: the process blocks on stdin and
does nothing until answered. "Report when you need me" and "report at the
end of every work turn" describe the same event.

What keeps reports weighty is the `bench-report` skill's content contract —
the ask first, evidence only where the decision hinges on it, the verified
and not-verified split — not the frequency of the gate.

## The thread

One conversation per specialist. It holds exactly three kinds of entry:

1. **Your messages.** Chat and decisions alike. A decision renders as what
   you chose, e.g. `chose "symlink"`, with any free text beneath it.
2. **The specialist's prose replies**, from chat turns.
3. **Report cards.** Title and summary always visible; the full report
   expands inline, rendered in its sandboxed frame exactly as now.

Nothing else. No tool calls, no activity feed, no thinking. While a
specialist works, the thread does not change at all — the roster carries
in-flight visibility. A work turn produces exactly one thread entry: its
report card.

**What gets mounted, not just what gets fetched.** The daemon's `/thread`
route always returns every entry — the record is the record, and trimming
it was ruled out. But a specialist that runs for hundreds of turns produces
a thread the browser should not fully mount: the worst thread on this bench
reached 237 entries and 3048 DOM nodes for `#thread` alone, 80% of the
page's DOM, laid out and reconciled on every roster push (#68). `Thread.tsx`
therefore renders only the newest entries — `useThreadWindow.ts`'s `WINDOW`,
12 by default, chosen empirically against that session's own node density
rather than rounded for looks — plus a `#thread-load-older` button that
reveals the rest, all at once, when pressed. A thread under the window
renders exactly as before: no button, nothing new. Opening a specialist
still lands on its newest entry; loading older entries preserves the
developer's scroll position rather than jumping to either end; and the
window resets to collapsed whenever the selected specialist changes, so an
expanded thread never carries over onto the next one read.

This is a deliberate rejection of the live activity feed. Watching an agent
work is not the product; reading its conclusions and answering is.

## The cockpit

**Roster, left.** Carries all in-flight visibility, since the thread
carries none. Each row: label, state, and one live line of what it is on. A
row awaiting a decision is visually loud — accent colour and weight —
because it is the only thing that ever requires action. Everything else
stays calm. A row that is merely working must never compete with one that
is waiting.

**Thread, centre.** Quiet, scrolling, as above.

**Composer, bottom.** One input slot, always in the same place.
Ordinarily a chat box. When a report lands it becomes the decision:
numbered options, `Enter` to confirm, `/` to drop into free text. The slot
never moves, so answering is muscle memory and saying something else is
always one keystroke away.

## Theme

Dark, green-cast, single theme. The light palette from Slice 1 is dropped;
this is a tool that runs on one developer's machine all day, and
maintaining two palettes buys nothing.

```
--bg           #0c1210     page ground
--panel        #111a16     roster, composer
--raised       #16211c     cards, inputs
--line         #ffffff14   borders, dividers
--hover        #ffffff0d   row and button hover
--text         #e8efe9     primary
--muted        #8ba396     secondary, status
--accent       #4fd18b     awaiting decision, selection, focus
--accent-dim   #2b6b4c     accent borders, pressed states
--danger       #e0685c     crashed, provisioning failed
```

Borders and hovers are low-alpha white rather than fixed greys. A solid
border colour is tuned to one background and goes wrong the moment it sits
on another; `#ffffff14` stays correct on `--bg`, `--panel` and `--raised`
alike. This is lifted from Claude's own dark UI, read off the page while
trying to fetch the reference artifact.

Accent is reserved. It marks the thing needing action and nothing else — a
working row, a normal card and a plain message are all `--muted` and
`--text`. If accent appears twice on screen, one of them is wrong.

Type is the system UI stack for prose and `ui-monospace` for status lines,
counts and anything from a terminal. Density is comfortable rather than
compact: this is a page you glance at to make one decision, not a dashboard
you scan.

**This palette is a first proposal.** It was written without sight of the
reference the developer supplied — the artifact could not be fetched, twice
— and is expected to be corrected.

## What changes in the daemon

The client rework is the visible half; four daemon changes make it possible.

**Turn kinds.** `.turn-kind` written beside `.turn` before each turn; the
`report-required` gate reads it and exempts `chat`.

**The codec captures reply text.** `activityLine` currently extracts tool
names and discards prose entirely, so a chat reply would arrive nowhere.
The `result` event already carries the turn's final text in its `result`
field, so the codec gains `replyText()` reading that, rather than
accumulating streamed assistant blocks. Streaming buys nothing here: the
thread is quiet and a reply is only shown once the turn ends.

**A thread store.** Per-session, on disk beside the reports, so a thread
survives a browser refresh and a daemon restart. Append-only: each entry is
`{ seq, at, kind: "user" | "reply" | "report", body }`.

**A message route.** `POST /api/sessions/:id/message` for chat, distinct
from `/answer`. Both append to the thread; only `/answer` sets a work turn.

## Errors

| Failure | Behaviour |
|---|---|
| Message sent to a session whose process has died | rejected with a clear reason; the thread records nothing |
| Message sent while a turn is running | accepted and queued; the thread shows it as sent, and the roster explains the specialist is still working |
| Thread store unreadable | the thread renders empty with a notice; chat still works, since the store is a record and not the transport |
| Chat turn writes a report anyway | the report is shown; nothing breaks. The gate governs what is required, not what is permitted |

## Image Attachments (Added 2026-08-28)

Images can be attached to any user message (pasted, dragged & dropped, or picked via a file button) and are sent to the CLI on stdin inside an Anthropic-compatible image content block.

**Data Model & Storage:**
- To avoid performance penalties from storing large base64 data in `thread.jsonl` (which is read on every cockpit load), images are saved separately to disk under `<reportsDir>/images/<uuid>.<ext>`.
- The `ThreadEntryInput` data structure records references to these stored files: `images: Array<{ name: string, mediaType: string }>`.
- Stored attachments are served back to the cockpit via `GET /api/sessions/:id/image/:name`.

**Client Experience & Input Flow:**
- The composer allows pasting, dropping, or browsing to add up to 8 images (capped at 5 MB total).
- Images exceeding 1568px on the long edge are automatically downscaled in the browser prior to upload to optimize token costs and comply with model limits.
- If a specialist is running on a proxied model (e.g. Gemini, which does not translate image blocks in the proxy), trying to attach an image prompts the user to switch the specialist to a Claude model, rather than sending a broken message or dropping the image silently.

## Testing

- **Turn kinds** unit-tested at the gate: a `chat` kind exempts, a `work`
  kind blocks, a missing kind blocks (fail safe, not fail open).
- **Codec text extraction** unit-tested for text blocks, mixed text and
  tool_use blocks, and empty content.
- **Thread store** unit-tested for append, read-back, ordering, and an
  unreadable store degrading to empty.
- **The message route** integration-tested: posting a message appends a
  user entry and reaches the session.
- **End to end**, against the real CLI: send a chat message, assert a prose
  reply arrives with no report written; then send a work turn and assert a
  report is required.

## Scope

In scope: turn kinds, codec text capture, the thread store, the message
route, and the full client rework — roster, thread, composer, theme.

Out of scope, unchanged from before: concurrency and the fleet, the
sub-agent tree, the decision queue, the migration lock, plan-mode two-phase
permissions. Those remain the next slice, and this work does not block
them.
