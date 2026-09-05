import { Skeleton } from "./Skeleton.js";

/** How wide each placeholder bubble reads, varied so two shapes do not look
 * like one entry repeated. */
const BUBBLES = ["85%", "60%"];

/**
 * A couple of entry shapes, standing in for a specialist's first read while
 * it is still in flight. Replaces "Working. Nothing to read yet" for that
 * one case - a specialist mid-conversation is not the same fact as one that
 * has genuinely said nothing (see `useThread.ts`'s `loading`, and #80).
 */
export function ThreadSkeleton() {
  return (
    <>
      {BUBBLES.map((width, i) => (
        <div className="entry" key={i} aria-hidden="true">
          <div className="who"><Skeleton width="4em" height="10px" /></div>
          <Skeleton className="bubble-skeleton" width={width} radius="3px 10px 10px 10px" />
        </div>
      ))}
    </>
  );
}
