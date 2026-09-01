import { useEffect, useState } from "react";
import { loadArtifact, type ArtifactContent } from "../api.js";

export interface ArtifactRef {
  /** "report" or "answer" - what the card calls it. */
  label: string;
  title: string;
  seq: number;
  file: string;
}

/**
 * A report and a reply are both rendered pages; only the file differs. The
 * card is a door, not a drawer: clicking it opens the page in a dialog.
 * Unfolding it in place put a document inside a column with the thread still
 * scrolling underneath, which is the wrong shape for the one thing you are
 * meant to read.
 *
 * A reply also previews here, because a reply is the answer to something you
 * asked and reading it should not cost a click.
 */
export function ArtifactCard({
  artifact, sessionId, preview, onOpen,
}: {
  artifact: ArtifactRef;
  sessionId: string;
  preview?: boolean;
  onOpen: (artifact: ArtifactRef) => void;
}) {
  const [content, setContent] = useState<ArtifactContent | null>(null);

  useEffect(() => {
    if (!preview) return;
    let live = true;
    void loadArtifact(sessionId, artifact.seq, artifact.file).then((result) => { if (live) setContent(result); });
    return () => { live = false; };
  }, [preview, sessionId, artifact.seq, artifact.file]);

  return (
    <article className="card">
      <button type="button" className="card-open" onClick={() => onOpen(artifact)}>
        <span className="kind">{artifact.label}</span>
        <span className="title">{artifact.title}</span>
        <span className="cue">open</span>
      </button>
      {/* Untrusted generated HTML. The sandbox withholds everything except a
          same-origin document, so no script in a report can run; the daemon
          sends a matching Content-Security-Policy with the page itself. */}
      {content?.kind === "url" && <iframe sandbox="allow-same-origin" title={artifact.title} src={content.url} />}
      {content?.kind === "html" && <iframe sandbox="allow-same-origin" title={artifact.title} srcDoc={content.html} />}
    </article>
  );
}
