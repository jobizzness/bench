/**
 * A beacon: something at the centre, and what it is putting out.
 *
 * Drawn symmetrically rather than as a one-sided wifi fan, because broadcast
 * here is not aimed at a device - it is "this is reachable", and the arcs
 * going both ways say that better than a signal pointing somewhere.
 *
 * Inline and on `currentColor` so it takes the state from the button it sits
 * in, the same way `GithubMark` does.
 */
export function BroadcastMark({ size = 16 }: { size?: number }) {
  return (
    <svg
      className="broadcast-mark"
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      role="img"
      aria-hidden="true"
      focusable="false"
    >
      <circle cx="8" cy="8" r="1.6" fill="currentColor" stroke="none" />
      <path d="M10.9 5.2a4 4 0 0 1 0 5.6" />
      <path d="M5.1 10.8a4 4 0 0 1 0-5.6" />
      {/* The outer pair carries the "and further than this machine" half, so
          it fades out when broadcast is off rather than disappearing - the
          shape stays recognisable as the same control either way. */}
      <path className="broadcast-far" d="M12.9 3.3a6.6 6.6 0 0 1 0 9.4" />
      <path className="broadcast-far" d="M3.1 12.7a6.6 6.6 0 0 1 0-9.4" />
    </svg>
  );
}
