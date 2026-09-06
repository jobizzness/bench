import { useEffect, useState, type TransitionEvent } from "react";

/**
 * Turns "this is genuinely new" into a one-shot fade-and-settle, tracked in
 * the component rather than a CSS `animation:` property - see
 * `PendingEntry.tsx` and #82. That ticket's lesson: a plain `animation:`
 * plays every time an element goes from not-rendered to rendered, which is
 * what a pane swap (`display: none`) and a folded `<details>` both do to an
 * element that never actually unmounted. A `transition` does not have that
 * problem - it only runs when the property it watches actually changes - so
 * this drives one by toggling classes from state the component owns, the
 * same shape as `PendingEntry`'s own `arrived` flag.
 *
 * `isNew` is read once, at construction, into `arriving`: whatever it does
 * on a later render must not turn the animation on or off, only the moment
 * this hook was first called decided that. Callers compute `isNew` from
 * data that survives a remount (`useRoster.ts`'s seen-ids, `useThread.ts`'s
 * seen-seqs) precisely so a component that mounts again later - a roster row
 * un-hidden is not one of these, but a thread entry revisited after a
 * specialist switch genuinely is - reads `isNew` as false the second time
 * and this hook never engages.
 *
 * `prefers-reduced-motion` is read the same way, once: nothing here ever
 * starts for a developer who asked not to see it, rather than starting and
 * relying on CSS to hide the motion, which would leave the transient class
 * attached (see below) with nothing to clear it.
 *
 * The class name toggles from `${name}-entering` (the "before" position, the
 * instant this mounts) to also carrying `${name}-arrived` a frame later (the
 * "after" position, for the transition to run to) - and then both are
 * dropped entirely once that transition's own `transitionend` fires, which
 * is the "cleared after the animation's own duration" #82 asks for: a later
 * un-hide of the same, still-mounted element finds no class here to replay,
 * because there no longer is one.
 */
export function useArrival(isNew: boolean, name: string): {
  className: string;
  onTransitionEnd: (event: TransitionEvent) => void;
} {
  const [reduced] = useState(
    () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches,
  );
  const [arriving] = useState(() => isNew && !reduced);
  const [arrived, setArrived] = useState(false);
  const [done, setDone] = useState(false);

  useEffect(() => {
    if (!arriving) return;
    const raf = requestAnimationFrame(() => setArrived(true));
    return () => cancelAnimationFrame(raf);
  }, [arriving]);

  if (!arriving || done) return { className: "", onTransitionEnd: () => {} };

  return {
    className: arrived ? `${name}-entering ${name}-arrived` : `${name}-entering`,
    // Bubbled transitions from something inside (a hover fade, a button's
    // own press feedback) must not be mistaken for this one finishing.
    onTransitionEnd: (event) => { if (event.target === event.currentTarget) setDone(true); },
  };
}
