/**
 * A plain chevron, pointing at the roster.
 *
 * Only ever drawn below the width breakpoint, on the one button that exists
 * to undo a roster row's own selection - so it borrows the same
 * currentColor convention as `GithubMark` and `BroadcastMark` rather than
 * inventing a second way for an icon to take its button's colour.
 */
export function BackMark({ size = 16 }: { size?: number }) {
  return (
    <svg
      className="back-mark"
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      role="img"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M10 3 5 8l5 5" />
    </svg>
  );
}
