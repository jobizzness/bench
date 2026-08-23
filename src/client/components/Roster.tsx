import { useState } from "react";
import type { RosterRow } from "../../shared/types.js";
import { useBenchActions, useBenchState } from "./context.js";
import { isWaiting } from "../waiting.js";
import { projectName } from "../format.js";

function detailOf(row: RosterRow): string {
  return row.status === "awaiting_decision"
    ? row.detail
    : `${row.status.replace(/_/g, " ")} · ${row.detail}`;
}

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
      <div className="label">
        <span className="label-name">{row.label}</span>
        {/* What kind of agent this is, beside what it is called. A tab named
            for its task said nothing about whether it builds or reads. */}
        <span className="role" data-role={row.role}>{row.role}</span>
        {/* Only when it is in your checkout. Its own worktree is the normal
            case, and a roster that says so on every row says nothing. */}
        {!row.isolated && row.branch !== "" && (
          <span className="row-shared" title={`Working in your checkout, on ${row.branch}`}>
            checkout
          </span>
        )}
      </div>
      <div className="detail">{detailOf(row)}</div>
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
  // Which groups the developer has folded away. Kept here rather than derived
  // from the rows, so a roster update does not spring them all open again.
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());

  const groups = new Map<string, RosterRow[]>();
  for (const row of rows) {
    if (!groups.has(row.project)) groups.set(row.project, []);
    groups.get(row.project)!.push(row);
  }

  return (
    <>
      {[...groups.entries()].map(([project, all]) => {
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
              setCollapsed((current) => {
                const next = new Set(current);
                if (open) next.delete(project);
                else next.add(project);
                return next;
              });
            }}
          >
            <summary title={project}>
              <span>{projectName(project)}</span>
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
