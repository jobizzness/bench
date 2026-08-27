import { useEffect, useRef, useState } from "react";
import { postJson } from "../api.js";
import { modelLabel } from "../../shared/models.js";
import type { RosterRow } from "../../shared/types.js";
import { ModelDialog } from "./ModelDialog.js";

/**
 * What another specialist is about to hand this tab, before it runs.
 *
 * A specialist's own `bench new` and first message would otherwise open a
 * tab and set it working without anyone else in the room. This is the room:
 * the prompt exactly as written - not editable, so this is a review rather
 * than a rewrite - a chance to move it off whatever model it inherited, and
 * one button that lets it go.
 *
 * Opens itself, driven by the row rather than a click: there is nothing else
 * to show yet for a tab that has taken no turn, so selecting it and reading
 * this are the same action. Declining does not close the tab - only the
 * developer can do that, with the row's own × - it just empties the tab back
 * out, exactly as if `bench tell` had never reached it.
 */
export function DispatchModal({ open, row, onClose }: {
  open: boolean;
  row: RosterRow | null;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [modelOpen, setModelOpen] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (!open || !row) { if (dialog.open) dialog.close?.(); return; }
    setError("");
    dialog.showModal?.();
  }, [open, row]);

  if (!row) return null;

  const act = async (path: "dispatch" | "decline") => {
    setError("");
    setBusy(true);
    try {
      const res = await postJson(`/api/sessions/${row.id}/${path}`, {});
      if (!res.ok) {
        setError((await res.json()).error ?? `Could not ${path} it.`);
        return;
      }
      onClose();
    } finally {
      setBusy(false);
    }
  };

  return (
    <dialog id="dispatch-modal" className="sheet" ref={ref} onClose={onClose}>
      <form onSubmit={(event) => { event.preventDefault(); void act("dispatch"); }}>
        <h2>{row.label}</h2>
        <p className="field-note" id="dispatch-modal-note">
          Told by another specialist. Held here until you send it - read it,
          move it off the model it inherited if you want to, then dispatch it
          or decline it.
        </p>

        <label htmlFor="dispatch-prompt">Prompt</label>
        <pre id="dispatch-prompt">{row.pendingPrompt}</pre>

        <label htmlFor="dispatch-model">Model</label>
        <button type="button" id="dispatch-model" onClick={() => setModelOpen(true)}>
          {modelLabel(row.model)}
        </button>

        <ModelDialog
          id="dispatch-model-dialog"
          open={modelOpen}
          current={row.model}
          sessionId={row.id}
          onClose={() => setModelOpen(false)}
        />

        {error && <p id="dispatch-modal-error" className="error">{error}</p>}

        <div className="actions">
          <button type="button" id="dispatch-decline" disabled={busy} onClick={() => void act("decline")}>
            Decline
          </button>
          <button type="submit" id="dispatch-dispatch" disabled={busy}>
            Dispatch
          </button>
        </div>
      </form>
    </dialog>
  );
}
