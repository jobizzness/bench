import { useState } from "react";
import type { RosterRow } from "../../shared/types.js";
import { useBenchActions, useBenchState } from "./context.js";
import { isWaiting } from "../waiting.js";
import { projectName } from "../format.js";
import { Meta } from "./Meta.js";
import { recall, remember } from "../remembered.js";
import { hideProject, useHiddenProjects } from "../hidden.js";

/** Folded projects, by path. Named once so the reader and the writer cannot
 * drift apart. */
const FOLDED = "folded-projects";

function Row({ row, selected }: { row: RosterRow; selected: boolean }) {
  const { select, closeSpecialist } = useBenchActions();

  return (
    <li
      className="row"
      data-status={row.status}
      // Status is not the same question as "does this want me". A specialist
      // that answered and wrote no report is awaiting_decision too, and the
      // roster was colouring it green while its own group count said nothing
      // was waiting.
      data-waiting={isWaiting(row)}
      aria-selected={selected}
      onClick={() => select(row.id)}
    >
      <div className="label"><span className="label-name">{row.label}</span></div>
      {/* Everything that is not its name, in one quiet line. The rail already
          says what the status is, in colour, so the word is not repeated
          here. */}
      <Meta row={row} />
      <button
        type="button"
        className="close"
        title="Close this specialist"
        aria-label={`Close ${row.label}`}
        onClick={(event) => {
          // The row underneath selects a specialist; closing one must not.
          event.stopPropagation();
          closeSpecialist(row);
        }}
      >
        ×
      </button>
    </li>
  );
}

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

  const fold = (next: ReadonlySet<string>) => {
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
      {[...groups.entries()].filter(([project]) => !hidden.has(project)).map(([project, all]) => {
        // Specialists waiting on you come first: several can need you at
        // once, so ordering is what makes the next one findable.
        const sorted = [...all].sort((a, b) => Number(isWaiting(b)) - Number(isWaiting(a)));
        const waiting = sorted.filter(isWaiting).length;

        return (
          <details
            className="group"
            key={project}
            open={!collapsed.has(project)}
            onToggle={(event) => {
              const open = (event.currentTarget as HTMLDetailsElement).open;
              const next = new Set(collapsed);
              if (open) next.delete(project);
              else next.add(project);
              fold(next);
            }}
          >
            <summary title={project}>
              <span>{projectName(project)}</span>
              {/* On hover, in the gap the layout already leaves. A control
                  that is always there is a control you read past every time,
                  and this one is used about twice a month. */}
              <button
                type="button"
                className="hide-project"
                title={`Hide ${projectName(project)} from this roster`}
                aria-label={`Hide ${projectName(project)}`}
                onClick={(event) => {
                  // Inside a summary, a click is a fold unless it is stopped.
                  event.preventDefault();
                  event.stopPropagation();
                  hideProject(project);
                }}
              >
                hide
              </button>
              <span className="count" data-waiting={waiting > 0}>
                {waiting > 0 ? `${waiting} waiting` : String(sorted.length)}
              </span>
            </summary>
            <ul className="group-rows">
              {sorted.map((row) => (
                <Row key={row.id} row={row} selected={row.id === selectedId} />
              ))}
            </ul>
          </details>
        );
      })}
    </>
  );
}
