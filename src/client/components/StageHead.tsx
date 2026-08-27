import { useState } from "react";
import { projectName } from "../format.js";
import { GithubMark } from "./GithubMark.js";
import { Meta } from "./Meta.js";
import { StageLabel } from "./StageLabel.js";
import { RoleDialog } from "./RoleDialog.js";
import { useBenchState } from "./context.js";

/**
 * Who is on the stage: their name, and one line of everything else.
 *
 * The roster carries a line; this carries badges. A column of twenty rows in
 * chips is noise, which is why the row is a line - but there is one specialist
 * here and room to let a fact be a thing you can see rather than a clause you
 * have to read. It also says the two the row has no room for: the status word,
 * read off the rail on a row, and the branch.
 */
export function StageHead({ onGithub }: {
  /** Opens the drawer of what has been happening on this project. */
  onGithub: () => void;
}) {
  const { rows, selectedId } = useBenchState();
  const [roleOpen, setRoleOpen] = useState(false);
  const row = rows.find((r) => r.id === selectedId);
  if (!row) return null;

  return (
    <header id="stage-head">
      <div id="stage-title">
        <StageLabel sessionId={row.id} label={row.label} />
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
      <Meta row={row} status branch badges onRole={() => setRoleOpen(true)} />
      {/* The roster carries the new role back, so nothing is held here that
          the daemon has not agreed to. */}
      <RoleDialog
        open={roleOpen}
        current={row.role}
        currentModel={row.model}
        sessionId={row.id}
        onClose={() => setRoleOpen(false)}
      />
    </header>
  );
}
