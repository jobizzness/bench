/**
 * A window with its left pane ruled off - the roster, drawn as the shape it
 * takes on screen. Same currentColor convention as `BackMark` and
 * `GithubMark`, so it takes its button's colour like every other icon here.
 */
export function PaneMark({ size = 15 }: { size?: number }) {
  return (
    <svg
      className="pane-mark"
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <rect x="1.75" y="2.75" width="12.5" height="10.5" rx="2" />
      <path d="M6.25 2.75v10.5" />
    </svg>
  );
}
