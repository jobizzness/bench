import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ThreadEntry as Entry } from "../../shared/types.js";

/**
 * Rendered by default. The worst thread on this bench today - 237 entries,
 * 3048 DOM nodes just for the thread (#68) - has recent entries far denser
 * than its average (report cards, not one-line chat), so a rounder number
 * like 20 only bought 7.5x. Measured directly against the real session: 12
 * is the smallest window that reliably clears an order of magnitude (266
 * nodes, 11.5x) without cutting into a single back-and-forth.
 */
const WINDOW = 12;

/**
 * Bounds how many thread entries React mounts at once.
 *
 * The thread on disk is append-only and unaffected - this only decides what
 * gets rendered. Older entries are a click away rather than missing. The
 * window resets to collapsed whenever the specialist changes, so an
 * expanded thread from one specialist never carries over onto the next.
 */
export function useThreadWindow(
  host: React.RefObject<HTMLDivElement | null>,
  sessionId: string | null,
  entries: Entry[],
): { visible: Entry[]; hiddenCount: number; expand: () => void } {
  const [expanded, setExpanded] = useState(false);
  useEffect(() => { setExpanded(false); }, [sessionId]);

  const hiddenCount = expanded ? 0 : Math.max(0, entries.length - WINDOW);
  const visible = hiddenCount > 0 ? entries.slice(hiddenCount) : entries;

  // Revealing older entries inserts content above whatever the developer is
  // looking at. Left alone, the browser keeps scrollTop numerically fixed,
  // which reads as the view jumping to a different place in the
  // conversation. The height is captured before the state change lands and
  // the jump is cancelled out once the taller thread has actually painted.
  const heightBeforeExpand = useRef<number | null>(null);
  const expand = () => {
    heightBeforeExpand.current = host.current?.scrollHeight ?? null;
    setExpanded(true);
  };
  useLayoutEffect(() => {
    const before = heightBeforeExpand.current;
    if (before === null || !host.current) return;
    host.current.scrollTop += host.current.scrollHeight - before;
    heightBeforeExpand.current = null;
  }, [visible, host]);

  return { visible, hiddenCount, expand };
}
