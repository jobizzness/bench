import { projectName } from "../format.js";
import { GithubMark } from "./GithubMark.js";
import { Meta } from "./Meta.js";
import { useBenchState } from "./context.js";

/**
 * Who is on the stage: their name, and one line of everything else.
 *
 * The line is the same one the roster row carries, with the two facts a row
 * has no room for - the status word, which on a row is read off the rail, and
 * the branch.
 */
export function StageHead({ onGithub }: {
  /** Opens the drawer of what has been happening on this project. */
  onGithub: () => void;
}) {
  const { rows, selectedId } = useBenchState();
  const row = rows.find((r) => r.id === selectedId);
  if (!row) return null;

  return (
    <header id="stage-head">
      <div id="stage-title">
        <span id="stage-label">{row.label}</span>
        {/* Top right of the pane the specialist is on, because the project it
            lists is that specialist's. */}
        <button
          id="open-github"
          type="button"
          title={`Issues and pull requests in ${projectName(row.project)}`}
          onClick={onGithub}
        >
          <GithubMark />
        </button>
      </div>
      <Meta row={row} status branch />
    </header>
  );
}
