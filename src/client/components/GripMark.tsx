/**
 * The grip on a roster row: two columns of three dots.
 *
 * The one shape a hand already reads as "this part moves", which is the whole
 * job - a row that can be dragged has to say so without a sentence, and it
 * only appears when the pointer is on the row anyway.
 */
export function GripMark() {
  return (
    <svg
      className="grip-mark"
      width="8"
      height="14"
      viewBox="0 0 8 14"
      fill="currentColor"
      role="img"
      aria-hidden="true"
      focusable="false"
    >
      <circle cx="1.6" cy="2.4" r="1.1" />
      <circle cx="6.4" cy="2.4" r="1.1" />
      <circle cx="1.6" cy="7" r="1.1" />
      <circle cx="6.4" cy="7" r="1.1" />
      <circle cx="1.6" cy="11.6" r="1.1" />
      <circle cx="6.4" cy="11.6" r="1.1" />
    </svg>
  );
}
