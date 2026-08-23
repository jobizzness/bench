import { useEffect, useRef } from "react";
import { artifactUrl } from "../api.js";
import type { ArtifactRef } from "./ArtifactCard.js";
import { ShareReport } from "./ShareReport.js";

/**
 * A report is a page, so it opens as one.
 *
 * Nothing is rendered inside until it is open: an iframe left loaded behind a
 * closed dialog keeps rendering, and the src is what tears it down. Esc, the
 * close button and the backdrop all reach `close()`, so there is one way out
 * rather than three.
 */
export function ArtifactDialog({
  open, sessionId, onClose,
}: {
  open: ArtifactRef | null;
  sessionId: string | null;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal?.();
    if (!open && dialog.open) dialog.close?.();
  }, [open]);

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
        {open && sessionId && (
          <ShareReport sessionId={sessionId} seq={open.seq} file={open.file} />
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
