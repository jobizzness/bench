/**
 * Pure geometry and threshold logic behind `useSheetDismissGestures`, split
 * out because jsdom has no layout, no compositor and no touch (#91) - this
 * is the slice of the gesture a unit test can actually exercise. The hook
 * itself only wires these to real DOM events; it gets checked by hand at a
 * real phone viewport instead (see the report on #91).
 */

export interface Rect { left: number; top: number; right: number; bottom: number; }

/** A `<dialog>` reports both a genuine backdrop click and a click that lands
 * on the dialog's own box - its padding, or any spot no child covers - as
 * `event.target === dialog`. The rect is what tells them apart. */
export function isOutsideDialog(clientX: number, clientY: number, rect: Rect): boolean {
  return clientX < rect.left || clientX > rect.right || clientY < rect.top || clientY > rect.bottom;
}

/** Past this far, or faster than this, a released drag finishes the dismiss
 * instead of springing back.
 *
 * Distance: 120px is roughly a thumb's travel and well short of the sheet's
 * own height, so a real attempt to pull it away succeeds without demanding a
 * drag that clears most of the screen.
 *
 * Velocity: 0.5px/ms is a flick fast enough that the finger left before it
 * travelled far - the sheet should read that as intent too, not only a slow
 * drag that happens to cross the distance line. */
export const DISMISS_DISTANCE = 120;
export const DISMISS_VELOCITY = 0.5;

export function pastDismissThreshold(distance: number, velocity: number): boolean {
  return distance >= DISMISS_DISTANCE || velocity >= DISMISS_VELOCITY;
}

/**
 * True only the instant a drag's distance reaches `DISMISS_DISTANCE` - not on
 * every touchmove after, and not only at release the way `pastDismissThreshold`
 * is checked. A gesture felt as physical needs the buzz at the crossing
 * itself, before the finger lifts (#95): this is what lets the hook tell "just
 * arrived" apart from "already past" without keeping the arithmetic itself in
 * the DOM-wired hook, the same split `pastDismissThreshold` already made.
 *
 * Velocity plays no part here, unlike `pastDismissThreshold` - it is only
 * known at release, and "as you cross it" is about a boundary the drag can
 * see mid-flight, not the flick check that only applies once the finger is
 * already gone.
 */
export function crossedDismissThreshold(previousDistance: number, distance: number): boolean {
  return previousDistance < DISMISS_DISTANCE && distance >= DISMISS_DISTANCE;
}

/** The nearest ancestor of `start` (inclusive), no further out than `root`
 * (inclusive), that actually has something to scroll. A sheet dialog gets
 * `overflow: auto` from the browser by default (`styles.css`'s own note on
 * `.sheet`), so `root` itself is always a valid answer when nothing closer
 * qualifies - which is the decision sheet's own case: `#unblock` scrolls
 * itself, it has no inner scroller. */
export function findScrollableAncestor(start: Element, root: Element): Element {
  let node: Element | null = start;
  while (node) {
    const style = getComputedStyle(node);
    const scrollable = (style.overflowY === "auto" || style.overflowY === "scroll") && node.scrollHeight > node.clientHeight;
    if (scrollable) return node;
    if (node === root) break;
    node = node.parentElement;
  }
  return root;
}
