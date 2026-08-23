import { useRef, useState } from "react";
import { postJson } from "../api.js";
import { useBenchActions, useBenchState } from "./context.js";

/**
 * Hand a report to another specialist.
 *
 * They are all top-level agents on one roster, so sharing is lateral: no
 * parent passing work down, just one specialist being asked to read what
 * another wrote. It arrives as an ordinary prompt and takes an ordinary
 * turn - the recipient reads the file itself rather than being given a
 * summary Bench made up.
 */
export function ShareReport({
  sessionId, seq, file, onShared,
}: {
  sessionId: string;
  seq: number;
  file: string;
  /** Closes the report, because what happens next is on another page. */
  onShared?: () => void;
}) {
  const { rows } = useBenchState();
  const { select } = useBenchActions();
  const [open, setOpen] = useState(false);
  const sending = useRef(false);

  // Within the project and nowhere else. A report is about one codebase, and
  // a specialist in another has no worktree it applies to - it would be
  // reading a file about somebody else's repository. Sharing a report back to
  // whoever wrote it is the other thing this cannot usefully do.
  const from = rows.find((r) => r.id === sessionId);
  const others = rows.filter((r) => r.id !== sessionId && r.project === from?.project);

  async function share(toId: string) {
    if (sending.current) return;
    sending.current = true;
    try {
      const res = await postJson(`/api/sessions/${sessionId}/share`, { seq, file, to: [toId] });
      if (!res.ok) return;

      // Go and watch. Sharing starts a turn on somebody else, and the thing
      // worth seeing next is them reading it - not the report you have just
      // finished with.
      setOpen(false);
      onShared?.();
      select(toId);
    } finally {
      sending.current = false;
    }
  }

  if (others.length === 0) return null;

  return (
    <div id="artifact-share">
      <button
        type="button"
        className="share-open"
        title="Ask another specialist to read this"
        onClick={() => setOpen((v) => !v)}
      >
        Share
      </button>

      {open && (
        <ul className="share-menu">
          {others.map((row) => (
            <li key={row.id}>
              <button type="button" onClick={() => share(row.id)}>
                <span className="share-label">{row.label}</span>
                <span className="share-project">{row.detail}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
