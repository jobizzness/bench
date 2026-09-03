import { useEffect, useRef } from "react";
import type { ThreadEntry as Entry } from "../../shared/types.js";
import type { ArtifactRef } from "./ArtifactCard.js";
import { ThreadEntry } from "./ThreadEntry.js";
import { useRefs } from "./useRefs.js";
import { useThreadWindow } from "./useThreadWindow.js";

function Empty({ heading, body }: { heading: string; body: string }) {
  return <p id="empty"><b>{heading}</b>{body}</p>;
}

/**
 * Frames have no height until they load, so one scroll at render time lands
 * somewhere in the middle. Re-pin as each settles.
 */
function usePinToBottom(host: React.RefObject<HTMLDivElement | null>, entries: Entry[]) {
  useEffect(() => {
    const node = host.current;
    if (!node) return;

    const jump = () => { node.scrollTop = node.scrollHeight; };
    jump();
    const raf = requestAnimationFrame(jump);

    const frames = [...node.querySelectorAll("iframe")];
    for (const frame of frames) frame.addEventListener("load", jump, { once: true });

    return () => {
      cancelAnimationFrame(raf);
      for (const frame of frames) frame.removeEventListener("load", jump);
    };
  }, [host, entries]);
}

export function Thread({
  entries, sessionId, hasRows, onOpen, unreachable = false,
}: {
  entries: Entry[];
  sessionId: string | null;
  hasRows: boolean;
  onOpen: (artifact: ArtifactRef) => void;
  /** The last read of this thread did not land. Says so rather than passing
   * off what did not arrive as a specialist that has said nothing (#62) - on
   * a relayed session that read fails several times an hour. */
  unreachable?: boolean;
}) {
  const host = useRef<HTMLDivElement>(null);
  usePinToBottom(host, entries);
  // Resolved once for the whole thread: the same number turns up in several
  // messages, and the answer is the same in all of them.
  const refs = useRefs(sessionId, entries);
  const { visible, hiddenCount, expand } = useThreadWindow(host, sessionId, entries);

  return (
    <div id="thread" ref={host}>
      {!sessionId
        ? (hasRows
          ? <Empty heading="Nothing selected." body="Pick a specialist on the left to read what it has for you." />
          : <Empty heading="No specialists yet." body="Start one with New and it will appear on the left." />)
        : entries.length === 0
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
            </>
          )}
    </div>
  );
}
