/**
 * A placeholder shaped like the thing it stands in for - not "nothing" and
 * not a decided state rendered early, the third thing a cold load needs (see
 * `usePhoneLanding.ts`, `useThread.ts`, `useDecision.ts`, `useReportFrame.ts`
 * for the hooks that now know they have not settled yet, #80).
 *
 * One component, sized by whoever needs a shape, rather than four hand-rolled
 * shimmers: a roster row, a thread entry, a decision and a report frame each
 * pass their own width and height and get the same shimmer, disabled the same
 * way everywhere under `prefers-reduced-motion` (see `.skeleton` in
 * styles.css). Width and height are left to CSS when not given, so a caller
 * that already has a box to fill - the report frame's own bordered container -
 * can hand that box a class instead of a size.
 */
export function Skeleton({ width, height, radius, className }: {
  width?: string;
  height?: string;
  /** A bare line gets a small pill radius from `.skeleton` itself; pass one
   * to stand in for a bigger bordered shape (a card, a bubble, a frame). */
  radius?: string;
  className?: string;
}) {
  const style: { width?: string; height?: string; borderRadius?: string } = {};
  if (width) style.width = width;
  if (height) style.height = height;
  if (radius) style.borderRadius = radius;

  return (
    <span
      aria-hidden="true"
      className={`skeleton${className ? ` ${className}` : ""}`}
      style={style}
    />
  );
}
