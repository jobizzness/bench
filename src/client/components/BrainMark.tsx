/**
 * The mark on the queue button.
 *
 * What is waiting is not a message or a task — it is a judgement somebody has
 * to make, and the specialist has stopped until it is made. A brain says that
 * where a bell or an inbox tray would say "something arrived".
 *
 * Drawn as one open profile with a fold through it rather than the usual
 * cauliflower of loops: at 15px the loops close up into a blob, and the fold
 * is what still reads.
 */
export function BrainMark({ size = 15 }: { size?: number }) {
  return (
    <svg
      className="brain-mark"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      role="img"
      aria-hidden="true"
      focusable="false"
    >
      {/* The skull line: a profile that opens at the bottom, where a neck
          would be, so it reads as a head rather than a cloud. */}
      <path d="M15.5 20.5a4 4 0 0 1-4-4v-9a4 4 0 0 1 7.4-2.1 3.4 3.4 0 0 1 1.6 6 3.6 3.6 0 0 1-1.2 6.6" />
      <path d="M11.5 7.5a3.6 3.6 0 0 0-6.6 1.9 3.4 3.4 0 0 0-.4 6.3 3.6 3.6 0 0 0 3.3 4.6" />
      {/* The fold. One line, and the only interior detail — it is what makes
          it a brain instead of a helmet, and it survives being small. */}
      <path d="M11.5 7.5v13" />
      <path d="M11.5 12.5h3.2" />
      <path d="M11.5 16h-2.8" />
    </svg>
  );
}
