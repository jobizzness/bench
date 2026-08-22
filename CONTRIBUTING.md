# Contributing

## Running the tests

```bash
pnpm typecheck
pnpm test          # unit and jsdom suites
pnpm test:e2e      # against the real claude CLI - costs money, uses haiku
```

The end-to-end suites are skipped unless `BENCH_E2E=1`. They spawn real
`claude` processes.

## What counts as proven

A thing is not proven because a unit test passes. Bench supervises a real CLI,
and most of its bugs have come from places tests could not reach:

- reports were written to a path the specialist was not permitted to write, and
  every test missed it because fixtures live under `/tmp`, where writes are
  allowed and elsewhere they are not
- a layout collision between two panels, each capped correctly on its own,
  found by opening Chrome — jsdom cannot tell you what a layout looks like
- a guard that always fired, because it counted `node_modules` as unsaved work

If you claim something works, say how you checked. "The suite is green" is not
the same sentence as "I ran it".

## Commits

- No AI attribution. No `Co-Authored-By: Claude`, no "Generated with" footer.
  A `PreToolUse` gate denies it, and it matches trailers rather than the word,
  so a commit *about* `CLAUDE.md` passes fine.
- Say why, not what. The diff already says what changed.

## Code

- TypeScript, strict. `pnpm typecheck` covers the daemon and the client.
- Comments explain the reason a thing is the way it is, especially when it looks
  wrong. Delete comments that only restate the code.
- Small modules with one job. If a file is hard to hold in your head, split it.
