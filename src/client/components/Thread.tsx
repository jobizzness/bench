import { useRef } from "react";
import type { ThreadEntry as Entry } from "../../shared/types.js";
import type { ArtifactRef } from "./ArtifactCard.js";
import { PendingEntry, type PendingMessage } from "./PendingEntry.js";
import { ThreadEntry } from "./ThreadEntry.js";
import { ThreadSkeleton } from "./ThreadSkeleton.js";
import { useRefs } from "./useRefs.js";
import { useThreadScroll } from "./useThreadScroll.js";
import { useThreadWindow } from "./useThreadWindow.js";

function Empty({ heading, body }: { heading: string; body: string }) {
  return <p id="empty"><b>{heading}</b>{body}</p>;
}

export function Thread({
  entries, sessionId, hasRows, onOpen, unreachable = false, loading = false, pending = [],
}: {
  entries: Entry[];
  sessionId: string | null;
  hasRows: boolean;
  onOpen: (artifact: ArtifactRef) => void;
  /** The last read of this thread did not land. Says so rather than passing
   * off what did not arrive as a specialist that has said nothing (#62) - on
   * a relayed session that read fails several times an hour. */
  unreachable?: boolean;
  /** This specialist's first read is still in flight - see `useThread.ts`.
   * Shows the skeleton instead of "Nothing to read yet", which used to be
   * said about a specialist mid-conversation the instant a phone selected
   * it (#80). */
  loading?: boolean;
  /** Sent from this page, not yet confirmed by a reload - see `App.tsx`'s
   * `submit()` (#86). Drawn after the windowed `entries`, always - a queue
   * this short is never itself worth paging. */
  pending?: PendingMessage[];
}) {
  const host = useRef<HTMLDivElement>(null);
  // Resolved once for the whole thread: the same number turns up in several
  // messages, and the answer is the same in all of them.
  const refs = useRefs(sessionId, entries);
  const { visible, hiddenCount, expand } = useThreadWindow(host, sessionId, entries);
  const { hasNewBelow, scrollToBottom } = useThreadScroll(host, sessionId, entries, pending, visible, hiddenCount);

  return (
    <div id="thread" ref={host}>
      {!sessionId
        ? (hasRows
          ? <Empty heading="Nothing selected." body="Pick a specialist on the left to read what it has for you." />
          : <Empty heading="No specialists yet." body="Start one with New and it will appear on the left." />)
        : loading
          ? <ThreadSkeleton />
          : (entries.length === 0 && pending.length === 0)
            ? (unreachable
              ? <Empty heading="Can't reach this machine." body="The conversation is on it; this device could not fetch it. Still trying." />
              : <Empty heading="Working." body="Nothing to read yet — the first report will land here." />)
            : (
              <>
                {unreachable && (
                  <p id="thread-stale">Lost the connection. This is the last of it that reached you.</p>
                )}
                {/* The conversation is never truncated on disk, only unrendered
                    until asked for - see useThreadWindow.ts (#68). */}
                {hiddenCount > 0 && (
                  <button id="thread-load-older" type="button" onClick={expand}>
                    Show {hiddenCount} earlier
                  </button>
                )}
                {visible.map((entry) => (
                  <ThreadEntry key={entry.seq} entry={entry} sessionId={sessionId} refs={refs} onOpen={onOpen} />
                ))}
                {pending.map((message) => (
                  <PendingEntry key={message.id} message={message} refs={refs} />
                ))}
                {/* A message landed while the reader was up-thread (#92) -
                    said quietly rather than yanking them down to it. */}
                {hasNewBelow && (
                  <button id="thread-new-below" type="button" onClick={scrollToBottom}>
                    New message ↓
                  </button>
                )}
              </>
            )}
    </div>
  );
}
