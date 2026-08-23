<img src="mark.svg" width="60" height="60" alt="">

# Brand

## The mark

A bench, three specialists at rest, and one standing.

It is the roster drawn small — several waiting, and one of them wanting you —
which is the whole product in one shape. The standing figure is the only one
with a head, and that is doing work: without it the silhouette is three short
bars and one tall one, which at 16px is a growth chart. It was a growth chart
in the first draft, and moving the standing figure off the right-hand end and
giving it a head is what fixed it.

It reduces honestly. At favicon size the resting figures fade to a bar and the
green stroke is what is left, which is the right thing to be scanning a tab
strip for.

Never redraw it with all four standing, or with heads on all four. Both were
tried: four heads mush into a band by 16px, and four standing says nothing.

## Colour

Taken from the cockpit rather than invented beside it, so the two cannot
drift. The mark in the client is inline SVG and inherits these as tokens;
`mark.svg` and `src/client/favicon.svg` carry them literally because neither
has a stylesheet to inherit from.

| Token | Value | Where |
|---|---|---|
| `--ground` | `#16211c` | The page behind everything |
| `--muted` | `#7e948a` | The bench and the specialists at rest |
| `--wants` | `#63d39b` | The one standing — and only ever that |
| `--text` | `#e8efe9` | Prose |

The accent means *this wants you*. It is the roster's "waiting" badge, the
standing figure in the mark, and the focus ring. Spending it anywhere else is
how it stops meaning anything.

## Type

The cockpit is set in the system sans, with a mono face for anything a machine
produced — commands, file paths, the trail.

Reports and replies are the exception and the deliberate one: they are set in
a serif, because a report is a document you read once and decide from rather
than a log you scan. That pairing lives in `src/daemon/artifact-page.ts`, and
it is the reason a report looks unlike the app around it.

## The wordmark

`Bench`, sentence case, beside the mark at a size that matches the cap height.
In the cockpit's roster header it is uppercase with wide tracking because it
sits in the mono UI voice there; in prose it is written normally.
