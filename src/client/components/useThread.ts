import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
const NO_NEW_SEQS: ReadonlySet<number> = new Set();

/**
 * Which of `entries` (all belonging to `id`) are above the highest `seq`
 * this hook has already recorded for that specific session - and advances
 * the record to match. A `Map` keyed by session id, not one number, because
 * this hook outlives any one specialist: switching away and back must not
 * forget what was already read there and re-flag it as new (#82's "second
 * use" - `ThreadEntry` remounts on the way back, since `entries` collapses
 * to nothing for a session that is not the selected one, but the record
 * here does not, so the id that mounts fresh still reads `isNew` false the
 * second time).
 *
 * `initialized` is the same "first load reports nothing" rule `useRoster.ts`
 * needs, kept separately per session: the first thread a specialist ever
 * shows must not animate its whole history in, but the *next* specialist you
 * open must not inherit that "nothing is new yet" grace from the first one's
 * bookkeeping either - each id earns its own.
 */
function useNewEntrySeqs(id: string | null, entries: ThreadEntry[]): ReadonlySet<number> {
  const seen = useRef<Map<string, number>>(new Map());
  const initialized = useRef<Set<string>>(new Set());

  const newSeqs = useMemo(() => {
    if (id === null || !initialized.current.has(id)) return NO_NEW_SEQS;
    const floor = seen.current.get(id) ?? -Infinity;
    const fresh = entries.filter((entry) => entry.seq > floor);
    return fresh.length === 0 ? NO_NEW_SEQS : new Set(fresh.map((entry) => entry.seq));
  }, [id, entries]);

  useEffect(() => {
    if (id === null) return;
    if (entries.length > 0) initialized.current.add(id);
    const floor = seen.current.get(id) ?? -Infinity;
    const highest = entries.reduce((max, entry) => Math.max(max, entry.seq), floor);
    seen.current.set(id, highest);
  }, [id, entries]);

  return newSeqs;
}

export function useThread(id: string | null, signature: string): {
  entries: ThreadEntry[];
  reload: () => Promise<void>;
  /** The last read did not land. What is on screen is the last copy that
   * did, or nothing if there has not been one yet. */
  threadUnreachable: boolean;
  /** This id's first read of the current signature is still in flight - no
   * good copy to show yet, and not yet known to have failed either. Gates
   * `Thread.tsx`'s skeleton, so switching to a specialist whose thread has
   * not loaded shows that instead of claiming there is nothing to read
   * (#80). Never true once there is a good copy to fall back on - a reload
   * after answering does not put the thread back into this state. */
  loading: boolean;
  /** `seq`s above the highest this hook has already recorded for `id` -
   * `ThreadEntry.tsx`'s own arrival, once, for a message actually new to the
   * conversation rather than the thread being redrawn or revisited (#82). */
  newSeqs: ReadonlySet<number>;
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

    // A fresh attempt for this id (or this id's new report) does not inherit
    // the previous one's outcome - left uncleared, a thread that just failed
    // once would read as unreachable for the next specialist too, for the
    // length of its own fetch (the same "decided before it knew" shape as
    // the rest of #80).
    setUnreachable(false);

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

  // Nothing to show yet, and not for lack of trying - a fetch for this exact
  // id is on its way and has not answered either way. Once `entries` holds a
  // good copy (`loaded.id === id`), this is false even mid-reload: there is
  // something to keep showing, so the skeleton is not the honest thing to
  // draw over it.
  const loading = id !== null && loaded.id !== id && !unreachable;
  const newSeqs = useNewEntrySeqs(id, entries);

  return { entries, reload, threadUnreachable: unreachable, loading, newSeqs };
}
