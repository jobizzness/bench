import { useEffect, useRef, useState } from "react";
import { authFetch, postJson } from "../api.js";
import { useBenchActions } from "./context.js";

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
    if (!LABEL_PATTERN.test(label.trim())) {
      setError("Label must be lowercase letters, numbers and hyphens, starting with a letter or number.");
      return;
    }

    setBusy(true);
    try {
      const res = await postJson("/api/sessions", {
        project: path, label: label.trim(), model, isolated,
      });
      // The old prompt flow discarded this response, so a rejected request
      // produced no specialist and no explanation.
      if (!res.ok) {
        setError((await res.json()).error ?? "Could not create the specialist.");
        return;
      }
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
          Lowercase letters, numbers and hyphens. Names the branch and worktree.
        </p>

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
