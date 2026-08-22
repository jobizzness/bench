import { useEffect, useRef, useState } from "react";
import { authFetch, postJson } from "../api.js";

interface Project { name: string; path: string }

// Matches the daemon's own label rule, so a bad label is caught here with an
// explanation instead of coming back as an opaque 400.
const LABEL_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** Accepts either a listed repo name or a full absolute path. */
function resolveProject(projects: Project[], value: string): string | null {
  const match = projects.find((p) => p.name === value || p.path === value);
  if (match) return match.path;
  return value.startsWith("/") ? value : null;
}

/**
 * A specialist is created empty and waits. What it is for is the first thing
 * you type at it, not a field in here — this dialog only decides where it
 * lives and what it costs.
 */
export function NewSessionDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const projectRef = useRef<HTMLInputElement>(null);

  const [projects, setProjects] = useState<Project[]>([]);
  const [project, setProject] = useState("");
  const [label, setLabel] = useState("");
  const [model, setModel] = useState("opus");
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
    if (!LABEL_PATTERN.test(label.trim())) {
      setError("Label must be lowercase letters, numbers and hyphens, starting with a letter or number.");
      return;
    }

    setBusy(true);
    try {
      const res = await postJson("/api/sessions", { project: path, label: label.trim(), model });
      // The old prompt flow discarded this response, so a rejected request
      // produced no specialist and no explanation.
      if (!res.ok) {
        setError((await res.json()).error ?? "Could not create the specialist.");
        return;
      }
      onClose();
    } finally {
      setBusy(false);
    }
  };

  const labelIsBad = label !== "" && !LABEL_PATTERN.test(label);

  return (
    <dialog id="new-dialog" ref={ref} onClose={onClose}>
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
          placeholder="password-reset"
          aria-invalid={labelIsBad}
          value={label}
          onChange={(event) => setLabel(event.target.value)}
        />
        <p className="field-note">
          Lowercase letters, numbers and hyphens. Becomes the worktree and branch name.
        </p>

        <label htmlFor="f-model">Model</label>
        <select id="f-model" value={model} onChange={(event) => setModel(event.target.value)}>
          <option value="opus">Opus</option>
          <option value="sonnet">Sonnet</option>
        </select>

        {error && <p id="f-error" className="error">{error}</p>}

        <div className="actions">
          <button type="button" id="f-cancel" onClick={onClose}>Cancel</button>
          <button type="submit" id="f-create" disabled={busy}>Create</button>
        </div>
      </form>
    </dialog>
  );
}
