import { usageTone } from "../../shared/usage.js";

/** The ring's geometry in the 16-unit box, and the length of the whole
 * circumference - which is what the dash array is measured in. */
const R = 5.6;
const ROUND = 2 * Math.PI * R;
/** A key with almost nothing spent still gets a mark. An arc that vanishes at
 * 1% reads as a key nobody has looked at rather than one barely touched. */
const STUB = 0.06;

/**
 * The mark on an OpenRouter meter: a ring, filled by how much of the key's
 * ceiling is gone.
 *
 * A ring rather than the columns the Anthropic mark uses, and deliberately
 * so. Columns say "several windows, this is the fullest"; there is only ever
 * one number here, and drawing it as a column of one would promise a set that
 * does not exist. The two accounts should not be mistakable for each other at
 * a glance, because the whole point of the mark is which one is being spent.
 *
 * A key with no ceiling is drawn as the bare track. There is no fraction to
 * fill, and a full ring would say the opposite of the truth.
 */
export function CreditMark({ percent = null, size = 15 }: {
  /** 0-100, or null for a key with no ceiling to be a fraction of. */
  percent?: number | null;
  size?: number;
}) {
  const spent = percent === null ? 0 : Math.min(100, Math.max(0, percent)) / 100;

  return (
    <svg
      className="usage-mark credit-mark"
      data-tone={percent === null ? undefined : usageTone(percent)}
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      role="img"
      aria-hidden="true"
      focusable="false"
    >
      {/* The track, always. It is the ceiling, and on a key with none it is
          the whole of the mark. */}
      <circle cx="8" cy="8" r={R} opacity={0.3} />
      {percent !== null && (
        <circle
          cx="8"
          cy="8"
          r={R}
          data-percent={percent}
          strokeDasharray={`${round(Math.max(STUB, spent) * ROUND)} ${round(ROUND)}`}
          // From the top, clockwise, which is the direction a meter is read.
          transform="rotate(-90 8 8)"
        />
      )}
    </svg>
  );
}

const round = (n: number) => Math.round(n * 100) / 100;
