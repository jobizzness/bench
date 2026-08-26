/**
 * The mark on the usage button.
 *
 * Three columns of different heights, which is the panel behind it in
 * miniature — the icon and the thing it opens are the same picture at two
 * sizes, so the button needs no label to say what it is.
 *
 * Drawn as strokes with round caps rather than filled rectangles: at 15px a
 * filled column loses its corners to the pixel grid and the three stop
 * reading as a set.
 */
export function UsageMark({ size = 15 }: { size?: number }) {
  return (
    <svg
      className="usage-mark"
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      role="img"
      aria-hidden="true"
      focusable="false"
    >
      {/* Short, tall, middling. Not a rising staircase: usage is not a trend
          and an ascending icon would promise one. */}
      <path d="M3.2 12.6V9.4" />
      <path d="M8 12.6V3.4" />
      <path d="M12.8 12.6V7" />
    </svg>
  );
}
