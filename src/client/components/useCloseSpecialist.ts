import { useCallback } from "react";
import type { RosterRow } from "../../shared/types.js";
import { postJson } from "../api.js";

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/**
 * Closing is permanent — the record is what a restart reads — and it takes the
 * worktree with it. The daemon refuses when that would destroy work and says
 * what, so the second question can be asked with the number in it.
 */
export function useCloseSpecialist(onClosed: (id: string) => void) {
  return useCallback(async (row: RosterRow) => {
    const warning = `Close ${row.label}?\n\n`
      + "Its worktree and branch are removed. The thread and any reports are kept.";
    if (!confirm(warning)) return;

    let res = await postJson(`/api/sessions/${row.id}/close`, {});

    if (res.status === 409) {
      const { changes, unmergedCommits } = await res.json();
      const lost = [
        changes ? `${plural(changes, "uncommitted file")}` : null,
        unmergedCommits ? `${plural(unmergedCommits, "commit")} on no other branch` : null,
      ].filter(Boolean).join(" and ");

      if (!confirm(`${row.label} has ${lost}.\n\nClosing destroys that. Close anyway?`)) return;
      res = await postJson(`/api/sessions/${row.id}/close`, { force: true });
    }

    if (res.ok) onClosed(row.id);
  }, [onClosed]);
}
