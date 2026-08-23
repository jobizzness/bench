import { useEffect, useRef } from "react";
import type { ThreadEntry as Entry } from "../../shared/types.js";
import type { ArtifactRef } from "./ArtifactCard.js";
import { ThreadEntry } from "./ThreadEntry.js";
import { useRefs } from "./useRefs.js";

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
  entries, sessionId, hasRows, onOpen,
}: {
  entries: Entry[];
  sessionId: string | null;
  hasRows: boolean;
  onOpen: (artifact: ArtifactRef) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  usePinToBottom(host, entries);
  // Resolved once for the whole thread: the same number turns up in several
  // messages, and the answer is the same in all of them.
  const refs = useRefs(sessionId, entries);

  return (
    <div id="thread" ref={host}>
      {!sessionId
        ? (hasRows
          ? <Empty heading="Nothing selected." body="Pick a specialist on the left to read what it has for you." />
          : <Empty heading="No specialists yet." body="Start one with New and it will appear on the left." />)
        : entries.length === 0
          ? <Empty heading="Working." body="Nothing to read yet — the first report will land here." />
          : entries.map((entry) => (
            <ThreadEntry key={entry.seq} entry={entry} sessionId={sessionId} refs={refs} onOpen={onOpen} />
          ))}
    </div>
  );
}
