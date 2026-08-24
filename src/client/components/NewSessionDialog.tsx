import { useEffect, useRef, useState } from "react";
import { authFetch, postJson } from "../api.js";
import { asRole, DEFAULT_ROLE, ROLES, ROLE_NOTE, type Role } from "../../shared/roles.js";
import { LABEL_MAX, labelIsUsable, slugify } from "../../shared/slug.js";
import { useBenchActions } from "./context.js";
import { showProject } from "../hidden.js";

interface Project { name: string; path: string }



/** Accepts either a listed repo name or a full absolute path. */
function resolveProject(projects: Project[], value: string): string | null {
  const match = projects.find((p) => p.name === value || p.path === value);
  if (match) return match.path;
  return value.startsWith("/") ? value : null;
}

/**
 * Two different jobs, and the difference is worth a sentence: a worktree is
 * private, the checkout is shared with the developer and with every other
 * specialist pointed at it.
 */
const WORKTREE_NOTE = {
  isolated: "Its own branch and files. Dependencies are linked from your checkout, never installed.",
  shared: "Works directly in your checkout, on the branch you have open - alongside you and any other specialist there.",
};

/**
 * A specialist is created empty and waits. What it is for is the first thing
 * you type at it, not a field in here — this dialog only decides where it
 * lives and what it costs.
 */
export function NewSessionDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { select } = useBenchActions();
  const ref = useRef<HTMLDialogElement>(null);
  const projectRef = useRef<HTMLInputElement>(null);

  const [projects, setProjects] = useState<Project[]>([]);
  const [project, setProject] = useState("");
  const [label, setLabel] = useState("");
  const [model, setModel] = useState("opus");
  const [role, setRole] = useState<Role>(DEFAULT_ROLE);
  const [isolated, setIsolated] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;

    if (!open) { if (dialog.open) dialog.close?.(); return; }

    setError("");
    setProject("");
    setLabel("");
    setModel("opus");
    setRole(DEFAULT_ROLE);
    setIsolated(true);
    dialog.showModal?.();
    projectRef.current?.focus();

    void (async () => {
      const res = await authFetch("/api/projects");
      setProjects(res.ok ? (await res.json()).projects : []);
    })();
  }, [open]);

  const submit = async () => {
    setError("");

    const path = resolveProject(projects, project.trim());
    if (!path) {
      setError("Pick a project from the list, or type an absolute path.");
      projectRef.current?.focus();
      return;
    }
    if (!labelIsUsable(label)) {
      setError(`Give it a name - anything up to ${LABEL_MAX} characters.`);
      return;
    }

    setBusy(true);
    try {
      const res = await postJson("/api/sessions", {
        project: path, label: label.trim(), role, model, isolated,
      });
      // The old prompt flow discarded this response, so a rejected request
      // produced no specialist and no explanation.
      if (!res.ok) {
        setError((await res.json()).error ?? "Could not create the specialist.");
        return;
      }
      // Making a specialist somewhere is the end of hiding that project:
      // otherwise the roster quietly refuses to show the thing you just made,
      // and the only clue is a count at the foot of the pane.
      showProject(path);
      // You made it to give it a job, so it is the one you want in front of
      // you. Leaving the old specialist on the stage meant finding the new
      // one in the roster yourself before you could say a word to it.
      const { id } = await res.json();
      if (id) select(String(id));
      onClose();
    } finally {
      setBusy(false);
    }
  };

  const labelIsBad = label.trim() !== "" && !labelIsUsable(label);

  return (
    <dialog id="new-dialog" className="sheet" ref={ref} onClose={onClose}>
      <form id="new-form" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
        <h2>New specialist</h2>

        <label htmlFor="f-project">Project</label>
        <input
          id="f-project" list="project-list" autoComplete="off" required
          ref={projectRef}
          placeholder="Start typing a repo name"
          value={project}
          onChange={(event) => setProject(event.target.value)}
        />
        <datalist id="project-list">
          {projects.map((p) => <option value={p.name} label={p.path} key={p.path} />)}
        </datalist>

        <label htmlFor="f-label">Label</label>
        <input
          id="f-label" autoComplete="off" required
          placeholder="Password reset"
          maxLength={LABEL_MAX}
          aria-invalid={labelIsBad}
          value={label}
          onChange={(event) => setLabel(event.target.value)}
        />
        {/* What it is called is yours; what git can hold is derived. The
            branch is shown rather than described, so the derivation is not a
            surprise the first time you look at `git branch`. */}
        <p className="field-note" id="f-label-note">
          Call it whatever you would call it out loud.
          {label.trim() !== "" && (
            <> Its branch will be <code>bench/{slugify(label)}-…</code></>
          )}
        </p>

        <label htmlFor="f-role">Role</label>
        <select
          id="f-role"
          value={role}
          onChange={(event) => setRole(asRole(event.target.value))}
        >
          {ROLES.map((option) => (
            <option value={option} key={option}>
              {option[0].toUpperCase() + option.slice(1)}
            </option>
          ))}
        </select>
        <p className="field-note" id="f-role-note">{ROLE_NOTE[role]}</p>

        <label htmlFor="f-model">Model</label>
        <select id="f-model" value={model} onChange={(event) => setModel(event.target.value)}>
          <option value="opus">Opus</option>
          <option value="sonnet">Sonnet</option>
        </select>

        <div className="check">
          <input
            type="checkbox" id="f-worktree"
            checked={isolated}
            onChange={(event) => setIsolated(event.target.checked)}
          />
          <label htmlFor="f-worktree">Start in a worktree</label>
        </div>
        <p className="field-note" id="f-worktree-note">
          {isolated ? WORKTREE_NOTE.isolated : WORKTREE_NOTE.shared}
        </p>

        {error && <p id="f-error" className="error">{error}</p>}

        <div className="actions">
          <button type="button" id="f-cancel" onClick={onClose}>Cancel</button>
          <button type="submit" id="f-create" disabled={busy}>Create</button>
        </div>
      </form>
    </dialog>
  );
}
