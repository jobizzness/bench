/**
 * The send glyph: a paper plane, the same stroke language as the attach
 * icon beside it. One shape for every state - idle, in flight, failed - the
 * button around it is what carries the difference (`#composer-send`'s own
 * `data-state` in styles.css), the same way `.row`'s rail carries a
 * specialist's status without redrawing the row.
 */
export function SendMark() {
  return (
    <svg
      className="send-mark"
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      role="img"
      aria-label="Send"
      focusable="false"
    >
      <line x1="21" y1="3" x2="10.5" y2="13.5" />
      <polygon points="21 3 14 21 10.5 13.5 3 10 21 3" />
    </svg>
  );
}
