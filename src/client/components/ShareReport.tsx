import { useRef, useState } from "react";
import { postJson } from "../api.js";
import { useBenchState } from "./context.js";

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
  sessionId, seq, file,
}: {
  sessionId: string;
  seq: number;
  file: string;
}) {
  const { rows } = useBenchState();
  const [open, setOpen] = useState(false);
  const [sentTo, setSentTo] = useState<number | null>(null);
  const sending = useRef(false);

  // Sharing a report back to whoever wrote it is the one thing this cannot
  // usefully do.
  const others = rows.filter((r) => r.id !== sessionId);

  async function share(toId: string) {
    if (sending.current) return;
    sending.current = true;
    try {
      const res = await postJson(`/api/sessions/${sessionId}/share`, { seq, file, to: [toId] });
      if (res.ok) {
        setSentTo((n) => (n ?? 0) + 1);
        setOpen(false);
      }
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
        {sentTo ? `Shared ×${sentTo}` : "Share"}
      </button>

      {open && (
        <ul className="share-menu">
          {others.map((row) => (
            <li key={row.id}>
              <button type="button" onClick={() => share(row.id)}>
                <span className="share-label">{row.label}</span>
                <span className="share-project">
                  {row.project.split("/").filter(Boolean).pop()}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
