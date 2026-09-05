import type { ThreadEntry as Entry } from "../../shared/types.js";
import { relativeTime } from "../format.js";
import { ArtifactCard, type ArtifactRef } from "./ArtifactCard.js";
import { Markdown } from "./Markdown.js";
import type { References } from "../markdown.js";

const WHO: Record<string, string> = { user: "you", reply: "specialist" };

/** A report card, a reply card, or something somebody said. */
export function ThreadEntry({
  entry, sessionId, refs, onOpen,
}: {
  entry: Entry;
  sessionId: string;
  refs?: References;
  onOpen: (artifact: ArtifactRef) => void;
}) {
  const who = WHO[entry.kind];

  const artifact: ArtifactRef | null =
    entry.kind === "report" && entry.reportSeq !== undefined
      ? { label: "report", title: entry.body, seq: entry.reportSeq, file: "report.html" }
      : entry.kind === "reply" && entry.replySeq !== undefined
        ? { label: "answer", title: entry.body, seq: entry.replySeq, file: "reply.html" }
        : null;

  return (
    // data-seq is read by useThreadScroll.ts to find this entry again after
    // the window has slid, so it can measure how far it moved rather than
    // guessing from a total height delta that would also include whatever
    // landed off-screen at the bottom.
    <div className={`entry ${entry.kind}`} data-seq={entry.seq}>
      {who && (
        <div className="who">
          {who}
          <span className="when">{relativeTime(entry.at)}</span>
        </div>
      )}
      {artifact
        ? (
          <ArtifactCard
            artifact={artifact}
            sessionId={sessionId}
            preview={entry.kind === "reply"}
            onOpen={onOpen}
          />
        )
        : (
          <>
            <Markdown className="bubble" text={entry.body} refs={refs} />
            {entry.images && entry.images.length > 0 && (
              <div className="entry-attachments">
                {entry.images.map((img, i) => (
                  <div key={i} className="entry-attachment">
                    <img
                      src={`/api/sessions/${sessionId}/image/${img.name}`}
                      alt="User attachment"
                      onClick={() => window.open(`/api/sessions/${sessionId}/image/${img.name}`, "_blank")}
                    />
                  </div>
                ))}
              </div>
            )}
          </>
        )}
    </div>
  );
}
