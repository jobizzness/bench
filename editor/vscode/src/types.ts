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
export interface EditEvent {
  id: string;
  label: string;
  project: string;
  tool: string;
  /** Absolute, on the machine the daemon is running on. */
  path: string;
  at: string;
}
