import { useEffect, useState } from "react";
import type { Decision, RosterRow } from "../../shared/types.js";
import { authFetch } from "../api.js";
import { isWaiting } from "../waiting.js";

export interface Waiting {
  row: RosterRow;
  /** null when the report could not be read, which is rare and still wants
   * answering - the queue hands those over rather than hiding them. */
  decision: Decision | null;
}

/**
 * Everything waiting on the developer, across every project, with the
 * decision itself already fetched.
 *
 * Keyed on which reports are waiting rather than on the roster, which pushes
 * several times a second: the set only changes when a specialist raises a
 * report or one gets answered, and refetching on every tick would throw away
 * a half-typed answer.
 */
export function useQueue(rows: RosterRow[], open: boolean): Waiting[] {
  const [items, setItems] = useState<Waiting[]>([]);

  const waiting = rows.filter(isWaiting);
  const key = waiting.map((row) => `${row.id}:${row.latestReportSeq}`).join(",");

  useEffect(() => {
    if (!open || key === "") { setItems([]); return; }

    let live = true;
    void (async () => {
      const found = await Promise.all(waiting.map(async (row) => {
        const res = await authFetch(`/api/sessions/${row.id}/report/${row.latestReportSeq}`);
        const decision: Decision | null = res.ok ? (await res.json()).decision : null;
        return { row, decision };
      }));
      if (live) setItems(found);
    })();

    return () => { live = false; };
    // Deliberately keyed on the reports, not on the rows.
  }, [open, key]);

  return items;
}
