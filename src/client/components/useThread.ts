import { useCallback, useEffect, useMemo, useState } from "react";
import type { RosterRow, ThreadEntry } from "../../shared/types.js";
import { authFetch } from "../api.js";

/**
 * What changes a thread: a turn starting or ending, and a report landing.
 * The cockpit used to refetch on every roster push — several times a second,
 * for a file that changes a few times an hour.
 */
export const threadSignature = (row: RosterRow | null): string =>
  row === null ? "" : `${row.status}:${row.latestReportSeq}:${row.answeredReportSeq}`;

/**
 * One read, with "could not reach it" told apart from "there is nothing
 * there".
 *
 * Both used to arrive as `[]`, and on a phone that is the difference between
 * a conversation and a lie: a dropped read rendered as "Working. Nothing to
 * read yet", for a specialist mid-conversation, and even changed the composer
 * to ask what the specialist was for (#62).
 */
async function fetchThread(id: string): Promise<ThreadEntry[] | null> {
  try {
    const res = await authFetch(`/api/sessions/${id}/thread`);
    if (!res.ok) return null;
    return (await res.json()).entries as ThreadEntry[];
  } catch {
    return null;
  }
}

const NOTHING: ThreadEntry[] = [];

export function useThread(id: string | null, signature: string): {
  entries: ThreadEntry[];
  reload: () => Promise<void>;
  /** The last read did not land. What is on screen is the last copy that
   * did, or nothing if there has not been one yet. */
  threadUnreachable: boolean;
} {
  // Keyed by the specialist the entries actually came from, so a failed read
  // can keep the last good copy without the risk that goes with it: switching
  // specialists while the link is down would otherwise show one specialist's
  // conversation under another's name, which is worse than showing none.
  const [loaded, setLoaded] = useState<{ id: string | null; entries: ThreadEntry[] }>({ id: null, entries: NOTHING });
  const [unreachable, setUnreachable] = useState(false);

  const entries = useMemo(
    () => (loaded.id === id ? loaded.entries : NOTHING),
    [loaded, id],
  );

  const reload = useCallback(async () => {
    if (!id) { setLoaded({ id: null, entries: NOTHING }); setUnreachable(false); return; }
    const next = await fetchThread(id);
    if (next === null) { setUnreachable(true); return; }
    setLoaded({ id, entries: next });
    setUnreachable(false);
  }, [id]);

  useEffect(() => {
    let cancelled = false;
    if (!id) { setLoaded({ id: null, entries: NOTHING }); setUnreachable(false); return; }

    void (async () => {
      const next = await fetchThread(id);
      if (cancelled) return;
      // Left alone on failure: `entries` is already empty for a specialist
      // this hook has not loaded yet, and the last good copy for one it has.
      if (next === null) { setUnreachable(true); return; }
      setLoaded({ id, entries: next });
      setUnreachable(false);
    })();

    return () => { cancelled = true; };
    // signature is the "something happened" trigger, not a value we read.
  }, [id, signature]);

  return { entries, reload, threadUnreachable: unreachable };
}
