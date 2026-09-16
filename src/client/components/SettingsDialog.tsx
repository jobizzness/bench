import { useEffect, useRef, useState } from "react";
import { authFetch, postJson } from "../api.js";
import { houseRules, NO_SETTINGS, type Settings } from "../../shared/settings.js";
import { REASONING_EFFORT_NOTE } from "../../shared/models.js";
import { RoleModels } from "./RoleModels.js";
import { ServerLocation } from "./ServerLocation.js";
import { HiddenProjects } from "./HiddenProjects.js";
import { ThemePicker } from "./ThemePicker.js";
import { Remote } from "./Remote.js";

type HeadroomStatus = {
  installed: boolean; state: string; url: string | null; port: number; reason: string | null;
};

/**
 * The sentence under the checkbox, one per state the proxy can be in. A
 * daemon that never answered reads as "not installed", which is the note
 * that tells the developer what to do rather than one that misleads.
 */
function headroomNote(status: HeadroomStatus | null): string {
  if (status === null || !status.installed) {
    return 'Headroom is not installed. Install it with: uv tool install --python 3.12 "headroom-ai[proxy]"';
  }
  if (status.state === "up") {
    return `Running at ${status.url ?? `http://127.0.0.1:${status.port}`} — applies to Anthropic-direct specialists on their next start. Gemini specialists are not routed through it.`;
  }
  if (status.state === "starting") {
    return "Headroom is starting — applies to Anthropic-direct specialists once it is up.";
  }
  if (status.state === "failed") {
    return `Headroom failed to start${status.reason ? ` (${status.reason})` : ""} — specialists run direct until it does.`;
  }
  return "Headroom is installed but not running — specialists run direct.";
}

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
export function SettingsDialog({ open, onClose, activeMachineName }: {
  open: boolean;
  onClose: () => void;
  /** Which machine these settings belong to - `null` for the one that served
   * this page. Everything in here (house rules, keys, the project list) is
   * per-daemon, and there is no single "the settings" across two laptops -
   * see "Machine-global routes" in the Firestore design. */
  activeMachineName: string | null;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const first = useRef<HTMLTextAreaElement>(null);

  const [draft, setDraft] = useState<Settings>(NO_SETTINGS);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  // What the daemon says about the proxy, asked when the dialog opens: the
  // note under the checkbox is a different sentence for each of the three
  // states, and guessing would tell the developer to install a thing that
  // is already running.
  const [headroom, setHeadroom] = useState<HeadroomStatus | null>(null);

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

    void (async () => {
      // Best effort: a daemon that predates this route (or one mid-restart)
      // just leaves the note on its safe default.
      const res = await authFetch("/api/headroom").catch(() => null);
      if (res?.ok) setHeadroom(await res.json());
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
        {/* Only shown once there is more than one machine to be ambiguous
            about - a solo laptop never needed to ask "which one". */}
        {activeMachineName && (
          <p className="field-note" id="s-active-machine">Settings for {activeMachineName}.</p>
        )}

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

        <label htmlFor="s-reasoning-effort">Reasoning effort</label>
        <select
          id="s-reasoning-effort"
          className="settings-select"
          value={draft.reasoningEffort}
          onChange={(event) => setDraft({ ...draft, reasoningEffort: event.target.value as any })}
        >
          <option value="none">Off (Minimal thinking)</option>
          <option value="low">Low</option>
          <option value="medium">Medium</option>
          <option value="high">High</option>
        </select>
        <p className="field-note">{REASONING_EFFORT_NOTE}</p>

        <div className="check">
          <input
            type="checkbox" id="s-headroom"
            checked={draft.headroom}
            disabled={headroom !== null && !headroom.installed}
            onChange={(event) => setDraft({ ...draft, headroom: event.target.checked })}
          />
          <label htmlFor="s-headroom">Compress prompts with Headroom</label>
        </div>
        <p className="field-note" id="s-headroom-note">{headroomNote(headroom)}</p>

        <details id="s-preview" open={framing !== ""}>
          <summary>What a specialist is told</summary>
          <pre id="s-framing">
            {framing === "" ? "Nothing. With both boxes empty, no house rules are sent at all." : framing}
          </pre>
        </details>

        <RoleModels
          chosen={draft.roleModels}
          onChange={(roleModels) => setDraft({ ...draft, roleModels })}
        />

        <p className="field-note" id="s-keys-note">API keys live in your profile — open it from the profile button at the top of the roster.</p>

        <ThemePicker />

        <ServerLocation open={open} />

        <Remote open={open} />

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
