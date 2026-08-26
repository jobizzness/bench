import { recall, remember } from "./remembered.js";

/**
 * The order the developer has put their specialists in, by hand.
 *
 * The roster's own order answers "who needs me next". A hand-made one answers
 * something the daemon cannot know: which of these you are actually working
 * on this afternoon, and which are running in the background. Both are worth
 * having, so a group keeps the sorted order until somebody drags a row in it
 * - and from then on that group is theirs.
 *
 * It lives in the browser, not on the daemon. It is an arrangement of a view,
 * like a folded group, and two tabs open on two screens may reasonably want
 * different ones.
 */
const ORDER = "roster-order";

/** Specialist ids, in the order they should be drawn, keyed by project. */
export type Order = Record<string, string[]>;

export function savedOrder(): Order {
  const saved = recall<Order>(ORDER, {});
  // Something else's key, or an older shape of this one. A roster that will
  // not draw is worse than one that has forgotten an arrangement.
  return saved !== null && typeof saved === "object" && !Array.isArray(saved) ? saved : {};
}

/** What is on screen now, kept for next time. Ids that have since been closed
 * are not written back: the caller passes what it drew, so the list prunes
 * itself. */
export function rememberOrder(project: string, ids: string[]): Order {
  const next = { ...savedOrder(), [project]: ids };
  remember(ORDER, next);
  return next;
}

/** The list with the row at `from` lifted out and put back down at `to`. */
export function moved<T>(items: readonly T[], from: number, to: number): T[] {
  const next = [...items];
  if (from < 0 || from >= next.length) return next;
  const [row] = next.splice(from, 1);
  next.splice(Math.max(0, Math.min(to, next.length)), 0, row);
  return next;
}

/** Where a row sat when the drag began: enough to say what the pointer is
 * now over, without measuring a list that is moving underneath it. */
export interface Slot { top: number; height: number }

/**
 * The place a row dragged to this height belongs.
 *
 * Measured against where the rows were when the drag started rather than
 * where they are now. The list reorders live under the pointer, so measuring
 * it again mid-drag would be measuring the answer to the previous question -
 * rows would swap back and forth across a single pixel of travel.
 */
export function dropIndex(slots: readonly Slot[], y: number): number {
  for (let i = 0; i < slots.length; i++) {
    if (y < slots[i].top + slots[i].height) return i;
  }
  return Math.max(0, slots.length - 1);
}

/**
 * Rows in the order the developer arranged them.
 *
 * A specialist started since then is not in that arrangement and goes to the
 * top: it is the one they just asked for, and the alternative is a new hire
 * appearing at the bottom of a long list nobody scrolls to.
 */
export function inOrder<T extends { id: string }>(rows: readonly T[], ids: readonly string[]): T[] {
  const place = new Map(ids.map((id, i) => [id, i]));
  const fresh = rows.filter((row) => !place.has(row.id));
  const arranged = rows
    .filter((row) => place.has(row.id))
    .sort((a, b) => place.get(a.id)! - place.get(b.id)!);
  return [...fresh, ...arranged];
}
