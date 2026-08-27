import { useEffect, useRef, useState } from "react";
import { postJson } from "../api.js";
import { ROLES, ROLE_NOTE, type Role } from "../../shared/roles.js";
import { ROLE_MODELS } from "../../shared/role-models.js";
import { modelLabel } from "../../shared/models.js";

/**
 * What kind of agent this is.
 *
 * Six of them and a sentence each, so a list rather than the model picker's
 * search - the whole set fits on one screen and the sentence is the reason to
 * pick one. Nothing here is worth typing to find.
 *
 * It says what each role runs on, because changing the role can change the
 * model underneath: a tab that has been taking whatever its role runs on keeps
 * doing that, and a reviewer moved to implementer would otherwise stay on the
 * cheap model the review was costed for. A model the developer picked by hand
 * is left alone, and then this line is the one thing on the page that is not
 * true of that tab - so it is marked.
 */
export function RoleDialog({
  open, current, sessionId, currentModel, onClose, onPick, id = "role-dialog",
}: {
  open: boolean;
  current: Role;
  /** The specialist to change. Absent reports the pick back instead, which is
   * what would let this same dialog be used before one exists. */
  sessionId?: string;
  /** What it is on now, to tell "follows the role" from "chosen by hand". */
  currentModel?: string;
  onClose: () => void;
  onPick?: (role: Role) => void;
  id?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (!open) { if (dialog.open) dialog.close?.(); return; }
    setError("");
    dialog.showModal?.();
  }, [open]);

  /** Whether the model would move with the role. It only does when the tab is
   * on the model its present role runs on; anything picked by hand stays. */
  const modelFollows = currentModel === undefined
    || currentModel === ROLE_MODELS[current].preferred
    || currentModel === ROLE_MODELS[current].direct;

  const choose = async (role: Role) => {
    if (role === current) { onClose(); return; }
    setError("");

    if (sessionId === undefined) {
      onPick?.(role);
      onClose();
      return;
    }

    setBusy(true);
    try {
      const res = await postJson(`/api/sessions/${sessionId}/role`, { role });
      const body = await res.json();
      if (!res.ok) {
        // The daemon's words: it is the one that knows whether the model the
        // new role wants needs a key there is not.
        setError(body?.error ?? "Could not change the role.");
        return;
      }
      onPick?.(role);
      onClose();
    } finally {
      setBusy(false);
    }
  };

  return (
    <dialog id={id} className="sheet" ref={ref} onClose={onClose}>
      <h2>Role</h2>
      <p className="field-note" id={`${id}-note`}>
        What this agent is told it is. Takes effect on the next prompt — it
        restarts on the new role and picks the conversation up where it left
        off.
      </p>

      <div className="role-options">
        {ROLES.map((role) => (
          <button
            type="button"
            key={role}
            className="role-option"
            data-role={role}
            data-current={role === current}
            aria-current={role === current}
            disabled={busy}
            onClick={() => void choose(role)}
          >
            <b>{role}</b>
            <span className="role-why">{ROLE_NOTE[role]}</span>
            <span className="role-model">
              {modelFollows || role === current
                ? modelLabel(ROLE_MODELS[role].preferred)
                : `stays on ${modelLabel(currentModel!)}`}
            </span>
          </button>
        ))}
      </div>

      {!modelFollows && (
        <p className="field-note" id={`${id}-kept`}>
          This one is on {modelLabel(currentModel!)} because you chose it. Changing
          the role leaves it there.
        </p>
      )}

      {error && <p id={`${id}-error`} className="error">{error}</p>}

      <div className="actions">
        <button type="button" id={`${id}-close`} onClick={onClose}>Close</button>
      </div>
    </dialog>
  );
}
