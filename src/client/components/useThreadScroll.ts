import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ThreadEntry as Entry } from "../../shared/types.js";
import type { PendingMessage } from "./PendingEntry.js";

/** Within this many pixels of the true bottom counts as "at the bottom" -
 * a reader who has nudged the view up by a few pixels of momentum scroll
 * has not asked to start reading up-thread. */
const BOTTOM_SLACK = 32;

const isAtBottom = (node: HTMLDivElement) =>
  node.scrollHeight - node.scrollTop - node.clientHeight <= BOTTOM_SLACK;

/** The thread is append-only, so its length and its last entry's `seq`
 * fully describe what is on screen - two reads with the same signature are
 * the same conversation, whatever `useThread`'s refetch handed back as a
 * freshly-allocated array (#92). */
const entriesSignature = (entries: Entry[]): string =>
  entries.length === 0 ? "" : `${entries.length}:${entries[entries.length - 1]!.seq}`;

/**
 * Decides, on every change to what the thread has to show, whether to pin
 * the view to the bottom, hold it exactly where it was, or leave a quiet
 * "new" affordance for the reader to act on themselves (#92).
 *
 * Three things drive a scroll adjustment, and only one of them forces a
 * jump to the bottom regardless of where the reader is:
 *  - switching specialists (a new thread starts at its own bottom)
 *  - sending a message (`pending` growing - #86's pull-down, kept)
 *  - already being at the bottom within `BOTTOM_SLACK` when the update lands
 *
 * Anything else leaves the scroll position alone. The one case that takes
 * active work to leave alone is the sliding window (`useThreadWindow`)
 * dropping an entry off the top: removing it shifts everything below up by
 * its height, and that has to be cancelled out or the reader would watch
 * their place in the conversation drift. The compensation anchors on
 * whichever visible entry survived the slide and corrects for exactly how
 * far *that entry* moved - not the thread's total height, which also
 * changes from whatever landed off-screen at the bottom and has nothing to
 * do with the reader's position.
 */
export function useThreadScroll(
  host: React.RefObject<HTMLDivElement | null>,
  sessionId: string | null,
  entries: Entry[],
  pending: PendingMessage[],
  visible: Entry[],
  hiddenCount: number,
): { hasNewBelow: boolean; scrollToBottom: () => void } {
  const [hasNewBelow, setHasNewBelow] = useState(false);

  // Live truth of "was the reader at the bottom", kept current by the
  // reader's own scrolling rather than recomputed after the DOM has already
  // changed shape - by the time an effect sees new `entries` the content has
  // already resized and scrollTop no longer means what it did a moment ago.
  const atBottomRef = useRef(true);
  useEffect(() => {
    const node = host.current;
    if (!node) return;
    const onScroll = () => {
      const atBottom = isAtBottom(node);
      atBottomRef.current = atBottom;
      if (atBottom) setHasNewBelow(false);
    };
    node.addEventListener("scroll", onScroll, { passive: true });
    return () => node.removeEventListener("scroll", onScroll);
  }, [host]);

  // What the previous run of the layout effect below saw - the "before"
  // half of every comparison it makes, since there is no lifecycle hook
  // that hands a function component the DOM as it stood pre-update.
  const prevSessionRef = useRef<string | null>(sessionId);
  const prevEntriesSigRef = useRef<string>(entriesSignature(entries));
  const prevPendingLenRef = useRef(pending.length);
  const prevHiddenCountRef = useRef(hiddenCount);
  // seq -> offsetTop, measured the moment the previous run settled. offsetTop
  // rather than a viewport rect: it is relative to #thread's own padding box
  // (see styles.css), so it does not need scrollTop folded back in and does
  // not move just because the reader scrolled.
  const anchorsRef = useRef<Map<number, number>>(new Map());
  // The layout effect's decision, handed to the passive effect below rather
  // than recomputed there - both belong to one settle.
  const shouldPinRef = useRef(false);

  const entriesSig = entriesSignature(entries);

  useLayoutEffect(() => {
    const node = host.current;
    if (!node) return;

    const isNewSession = sessionId !== prevSessionRef.current;
    const pendingGrew = pending.length > prevPendingLenRef.current;
    const droppedCount = Math.max(0, hiddenCount - prevHiddenCountRef.current);
    const gotNewContent = entriesSig !== prevEntriesSigRef.current;

    const shouldPin = isNewSession || pendingGrew || atBottomRef.current;
    shouldPinRef.current = shouldPin;

    if (shouldPin) {
      // Best-effort now, for whatever is already laid out. `Markdown.tsx`
      // fills a message's body in its own `useEffect`, which for a just-added
      // entry has not run yet at this point (layout effects fire before any
      // component's passive effects) - the passive effect below re-applies
      // this once children have painted their text, which is what actually
      // lands it on the true bottom.
      node.scrollTop = node.scrollHeight;
      atBottomRef.current = true;
      setHasNewBelow(false);
    } else {
      if (droppedCount > 0) {
        // Find whichever visible entry also appears in the previous
        // settle's map - the window only ever slides forward, so the
        // surviving entries are a contiguous run and any one of them
        // preserves all the others (#92). Every entry here survived from an
        // earlier commit, so unlike the pin branch above, its markdown is
        // already in and its height is already final - no second pass needed.
        for (const entry of visible) {
          const before = anchorsRef.current.get(entry.seq);
          if (before === undefined) continue;
          const el = node.querySelector<HTMLElement>(`[data-seq="${entry.seq}"]`);
          if (el) node.scrollTop += el.offsetTop - before;
          break;
        }
      }
      if (gotNewContent) setHasNewBelow(true);
    }

    // Refreshed unconditionally, including on the pin branch: next time the
    // reader is not at the bottom, this is what "before" means.
    const nextAnchors = new Map<number, number>();
    for (const entry of visible) {
      const el = node.querySelector<HTMLElement>(`[data-seq="${entry.seq}"]`);
      if (el) nextAnchors.set(entry.seq, el.offsetTop);
    }
    anchorsRef.current = nextAnchors;

    prevSessionRef.current = sessionId;
    prevEntriesSigRef.current = entriesSig;
    prevPendingLenRef.current = pending.length;
    prevHiddenCountRef.current = hiddenCount;
    // entries/pending/visible are read through entriesSig, .length and
    // hiddenCount above rather than listed directly - visible is fully
    // determined by entries and hiddenCount, and a refetch that lands the
    // same content in a new array must not retrigger this (#92).
  }, [host, sessionId, entriesSig, pending.length, hiddenCount]);

  useEffect(() => {
    const node = host.current;
    if (!node) return;

    // The rest of this update's settle: children's passive effects (chiefly
    // `Markdown.tsx`, which fills a message's body after mount) have now run,
    // so a message that just landed has its real height. Re-applying the
    // same target rather than computing a new one is what keeps this "one
    // settle continuing" instead of a second, different jump.
    if (shouldPinRef.current) node.scrollTop = node.scrollHeight;

    // Frames have no height until they load, so a report card can still
    // settle short of the true bottom after that. This is the one part of
    // the settle that has to wait on a genuine external event rather than
    // React's own effects - it only re-checks "is the reader still at the
    // bottom" and, if so, re-applies the same scrollTop assignment.
    const frames = [...node.querySelectorAll("iframe")];
    const onFrameLoad = () => {
      if (atBottomRef.current) node.scrollTop = node.scrollHeight;
    };
    for (const frame of frames) frame.addEventListener("load", onFrameLoad, { once: true });
    return () => {
      for (const frame of frames) frame.removeEventListener("load", onFrameLoad);
    };
  }, [host, sessionId, entriesSig, pending.length, hiddenCount]);

  const scrollToBottom = () => {
    const node = host.current;
    if (!node) return;
    node.scrollTop = node.scrollHeight;
    atBottomRef.current = true;
    setHasNewBelow(false);
  };

  return { hasNewBelow, scrollToBottom };
}
