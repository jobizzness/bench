/**
 * The wire shapes the extension reads off `/events`.
 *
 * A deliberate copy of `EditEvent` in Bench's own `src/shared/types.ts`, not
 * an import: this is a separate package with its own dependencies, and
 * reaching into the daemon's source would pull zod and the whole shared tree
 * into an editor extension for the sake of one interface. If the daemon's
 * shape changes, this changes with it - `tests/edit-events.test.ts` is what
 * pins the daemon's end.
 */
/**
 * As much of Bench's `RosterRow` as the extension reads. The real one carries
 * a great deal more - spend, context, model, the activity trail - and none of
 * it belongs in an editor.
 */
export interface RosterRow {
  id: string;
  label: string;
  /** The repo, not the worktree. */
  project: string;
  status: string;
  latestReportSeq: number | null;
  answeredReportSeq: number | null;
  /** Present only on a row the cockpit learned about from another machine.
   * Its paths are not ours and its daemon is not the one we are talking to. */
  machine?: { id: string; name: string };
}

/** One file a specialist has changed, as `/api/sessions/:id/changes` gives it. */
export interface ChangedFile {
  path: string;
  status: string;
  committed: boolean;
}

export interface Changes {
  base: string | null;
  files: ChangedFile[];
  /** The directory every path above is relative to - the specialist's
   * worktree, or the project itself when it has none. Absent only when the
   * request failed. */
  root?: string;
}

export interface EditEvent {
  id: string;
  label: string;
  project: string;
  tool: string;
  /** Absolute, on the machine the daemon is running on. */
  path: string;
  at: string;
}
