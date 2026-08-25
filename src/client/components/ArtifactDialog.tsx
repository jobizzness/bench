import { useEffect, useRef } from "react";
import { artifactUrl } from "../api.js";
import { useTheme } from "../theme.js";
import type { ArtifactRef } from "./ArtifactCard.js";
import { ShareReport } from "./ShareReport.js";
import { StartReview } from "./StartReview.js";

/**
 * A report is a page, so it opens as one.
 *
 * Nothing is rendered inside until it is open: an iframe left loaded behind a
 * closed dialog keeps rendering, and the src is what tears it down. Esc, the
 * close button and the backdrop all reach `close()`, so there is one way out
 * rather than three.
 */
export function ArtifactDialog({
  open, sessionId, onClose, onReviewing,
}: {
  open: ArtifactRef | null;
  sessionId: string | null;
  onClose: () => void;
  /** A reviewer was opened on this work; it becomes the tab in front of you. */
  onReviewing: (id: string) => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal?.();
    if (!open && dialog.open) dialog.close?.();
  }, [open]);

  // The theme rides on the artifact URL, so a report left open through a
  // theme change has to be asked for again to be redrawn. Subscribing here is
  // what makes the src change; the frame reloads itself off the back of it.
  useTheme();
  const src = open && sessionId ? artifactUrl(sessionId, open.seq, open.file) : null;

  return (
    <dialog
      id="artifact-dialog"
      ref={ref}
      onClose={onClose}
      onClick={(event) => { if (event.target === ref.current) onClose(); }}
    >
      <header>
        <span id="artifact-kind">{open?.label ?? ""}</span>
        <span id="artifact-title">{open?.title ?? ""}</span>
        {/* Only on a report. A reply is an answer to a question you asked;
            there is nothing there for a second pair of eyes to argue with. */}
        {open && sessionId && open.label === "report" && (
          <StartReview
            sessionId={sessionId}
            seq={open.seq}
            onOpened={(id) => { onReviewing(id); onClose(); }}
          />
        )}
        {open && sessionId && (
          <ShareReport
            sessionId={sessionId}
            seq={open.seq}
            file={open.file}
            onShared={onClose}
          />
        )}
        <a id="artifact-tab" href={src ?? undefined} target="_blank" rel="noreferrer"
           title="Open in a real tab">↗</a>
        <button type="button" id="artifact-close" aria-label="Close" autoFocus onClick={onClose}>
          ×
        </button>
      </header>
      {src && <iframe id="artifact-frame" sandbox="allow-same-origin" title={open!.title} src={src} />}
    </dialog>
  );
}
