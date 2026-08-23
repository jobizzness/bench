import type { RosterRow } from "../../shared/types.js";

/**
 * Which branch a specialist is on, and whether it has the place to itself.
 *
 * The second half is the one that matters. A specialist in your checkout is
 * editing the files you have open, on the branch you are on, and nothing on
 * screen said so - you found out by watching your own working tree change.
 */
export function Where({ row }: { row: RosterRow }) {
  if (row.branch === "") return null;

  return (
    <span
      className="where"
      data-shared={!row.isolated}
      title={row.isolated
        ? `Its own worktree, on ${row.branch}`
        : `Working in your checkout, on ${row.branch}`}
    >
      <svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true" focusable="false">
        <path d="M11.75 2.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm-2.25.75a2.25 2.25 0 1 1 3 2.122V6A2.5 2.5 0 0 1 10 8.5H6a1 1 0 0 0-1 1v1.128a2.251 2.251 0 1 1-1.5 0V5.372a2.25 2.25 0 1 1 1.5 0v1.836A2.492 2.492 0 0 1 6 7h4a1 1 0 0 0 1-1v-.628A2.25 2.25 0 0 1 9.5 3.25ZM4.25 12a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5ZM3.5 3.25a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0Z" />
      </svg>
      <span className="where-branch">{row.branch}</span>
      {!row.isolated && <span className="where-shared">your checkout</span>}
    </span>
  );
}
