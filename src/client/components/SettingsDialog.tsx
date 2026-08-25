import { useEffect, useRef, useState } from "react";
import { authFetch, postJson } from "../api.js";
import { houseRules, NO_SETTINGS, type Settings } from "../../shared/settings.js";
import { ReviewModel } from "./ReviewModel.js";
import { ServerLocation } from "./ServerLocation.js";
import { HiddenProjects } from "./HiddenProjects.js";
import { ThemePicker } from "./ThemePicker.js";
import { AnthropicKey } from "./AnthropicKey.js";

const PLACEHOLDER = {
  codingStyle:
    "Comments say why, never what.\nNo new dependencies without asking.\nTests read as sentences about behaviour.",
  workflowRules:
    "Run the tests before you say it passes.\nKeep the checklist current.\nAsk before touching a migration.",
};

/**
 * How you want work done, said once. Every specialist is told it at the start
 * of every turn - including the ones already running, which is why the rules
 * ride the framing rather than the system prompt.
 *
 * Global, not per project: a project's own conventions belong in its
 * CLAUDE.md, which specialists already read.
 */
export function SettingsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const first = useRef<HTMLTextAreaElement>(null);

  const [draft, setDraft] = useState<Settings>(NO_SETTINGS);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;

    if (!open) { if (dialog.open) dialog.close?.(); return; }

    setError("");
    dialog.showModal?.();
    first.current?.focus();

    void (async () => {
      const res = await authFetch("/api/settings");
      // Nothing saved yet reads as nothing set, which is also what a failed
      // load has to look like - the alternative is an empty box that silently
      // overwrites rules you had.
      if (!res.ok) { setError("Could not read your settings."); return; }
      setDraft({ ...NO_SETTINGS, ...((await res.json()).settings ?? {}) });
    })();
  }, [open]);

  const save = async () => {
    setError("");
    setBusy(true);
    try {
      const res = await postJson("/api/settings", draft);
      if (!res.ok) {
        setError((await res.json()).error ?? "Could not save your settings.");
        return;
      }
      onClose();
    } finally {
      setBusy(false);
    }
  };

  // Composed by the same function the daemon uses, so what is shown is what
  // is sent rather than a description of it.
  const framing = houseRules(draft);

  return (
    <dialog id="settings-dialog" className="sheet" ref={ref} onClose={onClose}>
      <form
        id="settings-form"
        onSubmit={(event) => { event.preventDefault(); void save(); }}
      >
        <h2>House rules</h2>

        <label htmlFor="s-style">Coding style</label>
        <textarea
          id="s-style" rows={4}
          ref={first}
          placeholder={PLACEHOLDER.codingStyle}
          value={draft.codingStyle}
          onChange={(event) => setDraft({ ...draft, codingStyle: event.target.value })}
        />
        <p className="field-note">How the code should read. Naming, comments, what a test looks like.</p>

        <label htmlFor="s-workflow">Workflow rules</label>
        <textarea
          id="s-workflow" rows={4}
          placeholder={PLACEHOLDER.workflowRules}
          value={draft.workflowRules}
          onChange={(event) => setDraft({ ...draft, workflowRules: event.target.value })}
        />
        <p className="field-note">
          How the work should go. Asked for, not enforced — a permission gate is
          the only thing that can promise.
        </p>

        <details id="s-preview" open={framing !== ""}>
          <summary>What a specialist is told</summary>
          <pre id="s-framing">
            {framing === "" ? "Nothing. With both boxes empty, no house rules are sent at all." : framing}
          </pre>
        </details>

        <ReviewModel
          value={draft.reviewModel}
          onChange={(reviewModel) => setDraft({ ...draft, reviewModel })}
        />

        <AnthropicKey open={open} />

        <ThemePicker />

        <ServerLocation open={open} />

        <HiddenProjects />

        {error && <p id="s-error" className="error">{error}</p>}

        <div className="actions">
          <button type="button" id="s-cancel" onClick={onClose}>Cancel</button>
          <button type="submit" id="s-save" disabled={busy}>Save</button>
        </div>
      </form>
    </dialog>
  );
}
