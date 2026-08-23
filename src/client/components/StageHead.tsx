import { projectName } from "../format.js";
import { GithubMark } from "./GithubMark.js";
import { Where } from "./Where.js";
import { useBenchState } from "./context.js";

export function StageHead({ onGithub }: {
  /** Opens the drawer of what has been happening on this project. */
  onGithub: () => void;
}) {
  const { rows, selectedId } = useBenchState();
  const row = rows.find((r) => r.id === selectedId);
  if (!row) return null;

  return (
    <header id="stage-head">
      <span id="stage-label">{row.label}</span>
      <span className="role" data-role={row.role}>{row.role}</span>
      <span id="stage-status">{`${row.status.replace(/_/g, " ")} · ${row.detail}`}</span>
      <Where row={row} />

      {/* Top right of the pane the specialist is on, because the project it
          lists is that specialist's - and here it can never be the button
          with nothing to show, since this header only exists with one open. */}
      <button
        id="open-github"
        type="button"
        title={`Issues and pull requests in ${projectName(row.project)}`}
        onClick={onGithub}
      >
        <GithubMark />
      </button>
    </header>
  );
}
