import { contextTone, fractionUsed } from "../../shared/context-window.js";
import type { Context } from "../../shared/context-window.js";

/** r=6 in a 16 box, so the ring clears a 2px stroke on both sides. */
const RADIUS = 6;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

/**
 * How full a specialist's conversation is, as a ring that fills.
 *
 * The number was set as words - "62% context" - which is a sentence to read
 * on a line that already has three. A dial does not need reading: full is a
 * shape, and the eye gets it from the roster without stopping. The words move
 * to the hover, where a number belongs when you want the exact one.
 *
 * The mark is the measurement rather than a picture of one, which is why it
 * is not a gauge icon with a needle: there is nothing to draw here that is
 * not the fraction itself.
 */
export function ContextMeter({ context }: { context: Context | null }) {
  const fraction = fractionUsed(context);
  if (fraction === null) return null;

  const tone = contextTone(context);
  const percent = Math.floor(fraction * 100);
  const said = `${percent}% of the conversation used`;

  return (
    <span className="meta-context" data-tone={tone} title={said}>
      <svg
        className="context-ring"
        width="13"
        height="13"
        viewBox="0 0 16 16"
        role="img"
        aria-label={said}
      >
        <circle className="context-track" cx="8" cy="8" r={RADIUS} fill="none" strokeWidth="2.4" />
        <circle
          className="context-fill"
          cx="8"
          cy="8"
          r={RADIUS}
          fill="none"
          strokeWidth="2.4"
          strokeLinecap="round"
          // Anticlockwise from the top, the way anything that fills is read.
          transform="rotate(-90 8 8)"
          strokeDasharray={`${fraction * CIRCUMFERENCE} ${CIRCUMFERENCE}`}
        />
      </svg>
    </span>
  );
}
