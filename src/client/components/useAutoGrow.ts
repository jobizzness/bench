import { useLayoutEffect, type RefObject } from "react";

/**
 * Grows the composer to fit what has been typed, then stops and scrolls.
 *
 * A box that grows without a ceiling eats the thread it is a reply to, and
 * the stage is a flex column - so the cap is the whole point, not a detail.
 */
export function useAutoGrow(
  ref: RefObject<HTMLTextAreaElement | null>,
  value: string,
  maxRows = 8,
): void {
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;

    // Measuring scrollHeight against the current height only ever grows: the
    // box has to be collapsed first for a deleted line to shrink it back.
    node.style.height = "auto";
    // jsdom lays nothing out, so every measurement here is zero. Leaving the
    // height alone is the honest answer there.
    if (node.scrollHeight === 0) return;

    const style = getComputedStyle(node);
    const line = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.5;
    // `box-sizing: border-box` is set globally, so the height being assigned
    // includes the borders - and scrollHeight does not. Setting one to the
    // other left the content two pixels taller than the box it was in, which
    // is why an empty composer wore a scrollbar.
    const borders = node.offsetHeight - node.clientHeight;
    const frame = borders + parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);

    node.style.height = `${Math.min(node.scrollHeight + borders, line * maxRows + frame)}px`;
  }, [ref, value, maxRows]);
}
