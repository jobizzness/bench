import { useCallback, useEffect, useState } from "react";
import type { RosterRow, ThreadEntry } from "../../shared/types.js";
import { authFetch } from "../api.js";

/**
 * What changes a thread: a turn starting or ending, and a report landing.
 * The cockpit used to refetch on every roster push — several times a second,
 * for a file that changes a few times an hour.
 */
export const threadSignature = (row: RosterRow | null): string =>
  row === null ? "" : `${row.status}:${row.latestReportSeq}:${row.answeredReportSeq}`;

export function useThread(id: string | null, signature: string): {
  entries: ThreadEntry[];
  reload: () => Promise<void>;
} {
  const [entries, setEntries] = useState<ThreadEntry[]>([]);

  const reload = useCallback(async () => {
    if (!id) { setEntries([]); return; }
    const res = await authFetch(`/api/sessions/${id}/thread`);
    setEntries(res.ok ? (await res.json()).entries : []);
  }, [id]);

  useEffect(() => {
    let cancelled = false;
    if (!id) { setEntries([]); return; }

    void (async () => {
      const res = await authFetch(`/api/sessions/${id}/thread`);
      const next = res.ok ? (await res.json()).entries : [];
      if (!cancelled) setEntries(next);
    })();

    return () => { cancelled = true; };
    // signature is the "something happened" trigger, not a value we read.
  }, [id, signature]);

  return { entries, reload };
}
