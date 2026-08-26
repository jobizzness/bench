import { fullest, usageTone, type UsageWindow } from "../../shared/usage.js";

/** The floor and ceiling a column is drawn between, in the 16-unit box. */
const FOOT = 12.6;
const HEAD = 3.4;
/** A window with almost nothing spent still gets a mark. A column that
 * vanishes at 1% reads as a missing window rather than an empty one. */
const STUB = 0.7;

/**
 * The mark on the usage button: the panel behind it, in miniature.
 *
 * The columns are the real windows at their real heights, so the button
 * answers the question without being opened - and it takes the colour of
 * whichever window is closest to full, which is the only part of the answer
 * worth interrupting anybody over. Below three-quarters it stays chrome.
 *
 * Drawn as strokes with round caps rather than filled rectangles: at 15px a
 * filled column loses its corners to the pixel grid and the columns stop
 * reading as a set.
 */
export function UsageMark({ windows = [], size = 15 }: {
  /** The windows the daemon named. Empty while the daemon is still being
   * asked, or when it has nothing to report. */
  windows?: UsageWindow[];
  size?: number;
}) {
  // Short, tall, middling. Not a rising staircase: with nothing to draw yet,
  // an ascending icon would promise a trend usage does not have.
  const columns = windows.length > 0 ? windows.map((w) => w.percent) : [35, 100, 61];
  const worst = fullest(windows);

  return (
    <svg
      className="usage-mark"
      data-tone={worst === null ? undefined : usageTone(worst.percent)}
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      // Thinner once there are more than three, or the columns close up into
      // a block. The daemon decides how many there are, not this file.
      strokeWidth={columns.length > 3 ? 1.5 : 2}
      strokeLinecap="round"
      role="img"
      aria-hidden="true"
      focusable="false"
    >
      {columns.map((percent, i) => (
        <path
          key={windows[i]?.key ?? i}
          data-percent={percent}
          d={`M${across(i, columns.length)} ${FOOT}V${head(percent)}`}
        />
      ))}
    </svg>
  );
}

/** Where the nth of `count` columns stands. Spread across the same span the
 * three-column mark always used, so the icon keeps its shape as windows come
 * and go. */
function across(i: number, count: number): number {
  if (count < 2) return 8;
  return round(3.2 + (i * 9.6) / (count - 1));
}

/** How far up a column reaches. Clamped at both ends: the API has been known
 * to report over a hundred, and a column taller than the box is a column
 * with its cap cut off. */
function head(percent: number): number {
  const spent = Math.min(100, Math.max(0, percent)) / 100;
  return round(FOOT - Math.max(STUB, spent * (FOOT - HEAD)));
}

const round = (n: number) => Math.round(n * 100) / 100;
