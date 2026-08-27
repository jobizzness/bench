/** Where the three ledger lines sit in the 16-unit box, and how far each
 * runs. Ragged on purpose: three equal rules read as a hamburger menu. */
const LINES = [
  { y: 4.5, from: 3, to: 13 },
  { y: 8, from: 3, to: 10.5 },
  { y: 11.5, from: 3, to: 12 },
];

/**
 * The mark on the spend meter: a few lines of a ledger.
 *
 * Neither of the shapes beside it would be honest here. The Anthropic mark is
 * columns because there are several windows and one of them is fullest; the
 * OpenRouter mark is a ring because there is a ceiling and some fraction of it
 * is gone. Spend has neither. It is a running total with nothing above it -
 * it only ever goes up, and there is no budget on this bench for it to be a
 * proportion of. An arc or a column here would invent a denominator that does
 * not exist, and would sit at some arbitrary fullness that a reader would
 * quite reasonably take for a warning. So the mark says where the money is
 * written down and nothing about how much; the amount is on the button's
 * label and in the panel, in words, which is where an unbounded number
 * belongs.
 *
 * Dashed when part of the total is a guess. The one thing about this figure
 * worth carrying at 15px is whether it is solid, and it is drawn as a texture
 * rather than a hue so it survives a colourblind reader, a greyscale screen
 * and a printed screenshot - the same rule the bars in the panels follow by
 * always printing their number.
 */
export function SpendMark({ estimated = false, size = 15 }: {
  /** Whether any of the total is a catalogue guess rather than a settled
   * charge. Not how much: that is a number, and this is an icon. */
  estimated?: boolean;
  size?: number;
}) {
  return (
    <svg
      className="spend-mark"
      data-estimated={estimated || undefined}
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
      {LINES.map((line) => (
        <path
          key={line.y}
          d={`M${line.from} ${line.y}H${line.to}`}
          // Two on, two off. Longer and the shortest line loses a dash and
          // stops matching the others; shorter and it closes up into a rule
          // again at this size.
          strokeDasharray={estimated ? "2 2" : undefined}
        />
      ))}
    </svg>
  );
}
