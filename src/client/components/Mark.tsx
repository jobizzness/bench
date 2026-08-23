/**
 * The Bench mark: a bench, three specialists at rest, and one standing.
 *
 * It is the roster drawn small - several waiting, one of them wanting you -
 * and the standing figure is the only one with a head, which is what stops it
 * reading as a bar chart once it is 16px tall.
 *
 * Inline rather than an <img>: it inherits the accent from the stylesheet, so
 * the mark and the cockpit can never drift apart.
 */
export function Mark({ size = 22 }: { size?: number }) {
  return (
    <svg
      className="mark-logo"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      role="img"
      aria-label="Bench"
      focusable="false"
    >
      <rect x="2.4" y="16.4" width="19.2" height="2.6" rx="1.3" className="mark-rest" />
      <rect x="4.6" y="11.4" width="2.4" height="5" rx="1.2" className="mark-rest" />
      <rect x="12.6" y="11.4" width="2.4" height="5" rx="1.2" className="mark-rest" />
      <rect x="16.6" y="11.4" width="2.4" height="5" rx="1.2" className="mark-rest" />
      <rect x="8.6" y="7.4" width="2.4" height="9" rx="1.2" className="mark-live" />
      <circle cx="9.8" cy="4.5" r="1.75" className="mark-live" />
    </svg>
  );
}
