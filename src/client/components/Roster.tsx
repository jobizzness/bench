import { useState } from "react";
import type { RosterRow } from "../../shared/types.js";
import { useBenchState } from "./context.js";
import { recall, remember } from "../remembered.js";
import { useHiddenProjects } from "../hidden.js";
import { RosterGroup } from "./RosterGroup.js";

/** Folded projects, by path. Named once so the reader and the writer cannot
 * drift apart. */
const FOLDED = "folded-projects";

/**
 * Grouped by project, never flat. Working across many repos at once, a flat
 * list gives no way to tell which specialist belongs to which codebase.
 */
export function Roster() {
  const { rows, selectedId } = useBenchState();
  // Kept out of this list by whoever is reading it. Not archived: see
  // hidden.ts - the specialists in there are still working.
  const hidden = useHiddenProjects();
  // Which groups the developer has folded away. Kept here rather than derived
  // from the rows, so a roster update does not spring them all open again -
  // and read from the browser on the way in, so neither does a refresh.
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(
    () => new Set(recall<string[]>(FOLDED, [])),
  );

  const fold = (project: string, open: boolean) => {
    const next = new Set(collapsed);
    if (open) next.delete(project);
    else next.add(project);
    setCollapsed(next);
    remember(FOLDED, [...next]);
  };

  const groups = new Map<string, RosterRow[]>();
  for (const row of rows) {
    if (!groups.has(row.project)) groups.set(row.project, []);
    groups.get(row.project)!.push(row);
  }

  return (
    <>
      {[...groups.entries()].filter(([project]) => !hidden.has(project)).map(([project, all]) => (
        <RosterGroup
          key={project}
          project={project}
          rows={all}
          selectedId={selectedId}
          open={!collapsed.has(project)}
          onFold={(open) => fold(project, open)}
        />
      ))}
    </>
  );
}
