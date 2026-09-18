/**
 * What the button in the roster header shows, decided from nothing but the
 * state of Bench's own checkout - no clock, no network, so this can be
 * tested as a table rather than a sequence of steps.
 *
 * `restart` outranks everything else: once `headSha` has moved past
 * `bootSha`, the running daemon is stale regardless of what the remote is
 * doing next, and that is the more urgent of the two things this button can
 * ask for.
 */
export type UpdateAction =
  | { kind: "none" }
  | { kind: "update"; behind: number }
  | { kind: "restart" }
  | { kind: "blocked"; reason: "dirty" | "diverged" };

export interface UpdateInputs {
  /** Commits on `origin/<branch>` not yet on `HEAD`. */
  behind: number;
  /** `git status --porcelain --untracked-files=no` found something - a
   * tracked file modified or staged. Untracked files do not count; see #149. */
  dirty: boolean;
  /** `HEAD` is an ancestor of `origin/<branch>` - a `--ff-only` merge would
   * succeed. */
  fastForward: boolean;
  /** The commit the daemon booted from, recorded once at startup. */
  bootSha: string;
  /** `HEAD` right now. */
  headSha: string;
}

export function updateAction(inputs: UpdateInputs): UpdateAction {
  if (inputs.headSha !== inputs.bootSha) return { kind: "restart" };
  if (inputs.behind === 0) return { kind: "none" };
  if (inputs.dirty) return { kind: "blocked", reason: "dirty" };
  if (!inputs.fastForward) return { kind: "blocked", reason: "diverged" };
  return { kind: "update", behind: inputs.behind };
}

/** What a `blocked` action, or a watcher that could not fetch, reads as in
 * the field-note beside `pinnedKeyNotice` - see `App.tsx`. */
export function blockedMessage(reason: "dirty" | "diverged"): string {
  return reason === "dirty"
    ? "This checkout has uncommitted changes, so it will not update itself."
    : "This checkout has diverged from its remote and cannot fast-forward.";
}

/**
 * Pushed alongside the roster (see `pinnedKeyNotice` in `server.ts`), so the
 * cockpit never has to poll for it.
 */
export interface SelfUpdateStatus {
  action: UpdateAction;
  /** The last `git fetch` failed - `action` is then whatever the checkout
   * last looked like on a successful fetch (or the resting `none` before the
   * first one), and this is said alongside it rather than in place of it, so
   * a watcher that cannot reach origin never reads as "up to date". */
  fetchError: string | null;
}
