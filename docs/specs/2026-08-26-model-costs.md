# What a model costs, before you pick it

Approved by the developer on 2026-08-26. Build what is here. Where this says
*your call*, it is yours; where it says *report it*, write a report and stop
rather than guessing.

## The problem

`ModelDialog.tsx` draws one price per model: dollars per million **output**
tokens. A specialist's turn is not shaped like that. It re-sends the whole
conversation on every tool call, so the bill is mostly input, and mostly input
that has already been cached — which OpenRouter prices separately at about a
tenth of fresh input. The one number on screen is the one that matters least.

Concretely, from the live catalogue: Kimi K3 reads as the obvious pick beside
Opus, and is **1.5× the price of Sonnet 5** for the same turn. Nothing in the
picker says so.

## What to build

### 1. Carry all three prices

`daemon/openrouter.ts` already fetches the catalogue and reads
`pricing.completion`. Keep the same rules — quoted per-token as a decimal
string, anything not a plain non-negative number is `null` rather than a
figure invented for the screen — and carry all of:

| field | from | note |
|---|---|---|
| fresh input | `pricing.prompt` | |
| cached input | `pricing.input_cache_read` | absent on many models; `null` then |
| cache write | `pricing.input_cache_write` | fall back to `prompt` when absent |
| output | `pricing.completion` | what is shown today |

Shape is your call — a `price` object on `Listed` reads better than four flat
fields, but it touches every test that builds one. No new network call: this
is the response already being parsed.

### 2. Record what a turn actually cost

Bench has never recorded this. The CLI's `result` event carries
`total_cost_usd` — declared in `stream-codec.ts:9`, read by nothing — and a
`usage.iterations` array with fresh, cache-written and cache-read input
separated per request. `contextFrom()` already walks it for the context meter;
read the rest of it in the same place.

Two things come out of one recording:

- **Per specialist: what it has spent.** Surfaced the way context fullness is —
  the roster row and the stage header. Dollars, not tokens.
- **Bench-wide: the shape of the last twenty turns.** Fresh in, cache-written
  in, cache-read in, out. A small ring buffer beside `sessions.json` in
  `~/.bench`, written with the same atomic write `store.ts` uses. This is what
  makes the estimate below true of *this developer* rather than of a brochure.

`total_cost_usd` is the CLI's own arithmetic against its Anthropic price table,
so for an OpenRouter-proxied model it is probably wrong or absent. **Verify
that against a real proxied turn and report what you find.** If it is not
usable, cost a proxied turn from its token shape and the catalogue price
instead — the same arithmetic as the estimate.

### 3. Estimate a turn

A pure module — `src/shared/cost.ts`, no DOM, no fetch — that takes a turn
shape and a model's prices and returns dollars:

```
fresh_in × in  +  cache_write × cacheWrite  +  cache_read × cachedIn  +  out × out
```

Averaged over the last twenty recorded turns. With fewer than three recorded,
say so on the page rather than showing a number built from one turn: *"from
your last 2 turns"* is a caveat, not a defect. With none at all, fall back to a
stated shape — 60k in, 80% of it cached, 4k out — and say on the page that it
is an assumption, not your history.

Unknown price anywhere in the sum means no estimate for that model. Not zero.

### 4. The row

Every row carries, as decided: **input and output price side by side**, **the
cached-input price as its own column**, **what a turn like yours would cost**,
and **how it compares to the model you are on** — "1.5× Sonnet 5".

That is four more things on a row that already has a name, an id and a window,
in a list that can be 289 long. The layout is your call, and it is the hard
part of this job. What must survive:

- The list stays one scannable column, capped at 40, search-first. Do not turn
  it into a grid of cards; that is what commit `0d94426` deliberately undid.
- The columns align down the list. A price that starts at a different x on
  every row cannot be compared, which is the whole point of showing it.
- The turn estimate is the loudest number on the row. It is the one that
  answers the question being asked.
- Prices need a legend — three bare dollar figures in a row are unreadable
  without one. Once, above the list, not on every row.

### 5. The rest, as decided

- **Anthropic's four say "on your Claude plan, not per token".** They are not
  billed per token on this bench, and a dollar figure beside them would be a
  lie. No estimate on them either.
- **Cheapest-first sort.** A control that switches the ranking from relevance
  to price ascending. Sort by the *estimated turn cost*, not by output price —
  ordering by the wrong number is the bug this whole spec is about. Models with
  no known price sort last, never first.
- **The baseline for "1.5× Sonnet 5" is the model the specialist is on now.**
  When that is an Anthropic model on the plan, use its OpenRouter list price for
  the arithmetic and make the label say what is being compared.

## How to build it

- Tests alongside, in the house style: a describe per behaviour, a sentence
  that says why rather than what. The arithmetic in `shared/cost.ts` is tested
  directly, without a DOM. The row and the sort are tested through the real
  cockpit with `tests/helpers/cockpit.js`, as `tests/model-dialog.test.tsx`
  already does.
- No new dependencies.
- `npm run typecheck` and `npx vitest run` both clean before you report. Say
  the numbers in your report.
- Match the comment voice around you: say why a thing is the way it is, not
  what the line does.
- **No Claude attribution in commits.** House rule, enforced at `PreToolUse`.

## Report rather than guess

- Whether `total_cost_usd` survives an OpenRouter turn.
- The row layout, if you cannot fit the four facts without breaking one of the
  constraints in §4. Show what you tried.
- Anything here that turns out to be wrong about the code. This spec was
  written from a read, not from a build.
