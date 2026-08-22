import type { ThreadEntry as Entry } from "../../shared/types.js";
import { relativeTime } from "../format.js";
import { ArtifactCard, type ArtifactRef } from "./ArtifactCard.js";
import { Markdown } from "./Markdown.js";

const WHO: Record<string, string> = { user: "you", reply: "specialist" };

/** A report card, a reply card, or something somebody said. */
export function ThreadEntry({
  entry, sessionId, onOpen,
}: {
  entry: Entry;
  sessionId: string;
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
    <div className={`entry ${entry.kind}`}>
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
        : <Markdown className="bubble" text={entry.body} />}
    </div>
  );
}
