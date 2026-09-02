import { useCallback, useEffect, useState } from "react";
import type { RosterRow } from "../../shared/types.js";
import { isWaiting } from "../waiting.js";
import { useNarrowViewport } from "./useNarrowViewport.js";

export type PhonePane = "roster" | "stage" | "unblock" | "empty";

export interface PhoneLanding {
  /** Which of the phone's screens is in front of the developer. Read by
   * `App.tsx` alongside `selectedId` to decide what to render; ignored
   * above the breakpoint, where every rule that acts on it lives inside
   * `@media (max-width: 720px)`. */
  pane: PhonePane;
  /** Wraps `select`: marks that the developer has taken the wheel, so the
   * landing effect below stops steering. Every user-initiated navigation
   * should go through this rather than the raw selector. */
  select: (id: string | null) => void;
  /** The escape hatch on the unblock and empty screens. Deselects (the
   * empty screen already has nothing selected, so this is a no-op there)
   * and marks the roster seen, so the landing effect does not steer you
   * straight back to whatever is still waiting. */
  browseRoster: () => void;
  /** How many are waiting, including whichever one is in front of you -
   * already discounting whatever you answered this session but the roster
   * has not caught up to yet (see `justAnswered` below). */
  waitingCount: number;
  /** Call once `row`'s answer has posted. Moves on to whatever else is
   * waiting, or lets the empty screen take over if that was the last one. */
  advance: (row: RosterRow) => void;
}

/** A row's report, not just the row - answering it and then getting a new
 * report on the same specialist is a different decision, and should not
 * still read as the one already answered. */
function waitingKey(row: RosterRow): string {
  return `${row.id}:${row.latestReportSeq}`;
}

/**
 * Where the phone opens, and what moves it on from there.
 *
 * A phone is the unblocking device: below the breakpoint the front door is
 * whatever is waiting, not a roster you would then have to navigate out of
 * (see #57). This is the one place that decides which of the phone's four
 * screens - roster, an open specialist, something waiting, or nothing
 * waiting - is in front of the developer, and it is a decision this hook
 * keeps rather than derives fresh every render: once the developer has
 * looked at the roster on purpose, landing on it again (rather than being
 * pulled back into the queue) is the only thing that keeps a phone build
 * from feeling like it is steering.
 */
export function usePhoneLanding(
  rows: RosterRow[],
  selectedId: string | null,
  rawSelect: (id: string | null) => void,
): PhoneLanding {
  const narrow = useNarrowViewport();
  const [seenRoster, setSeenRoster] = useState(false);
  // Optimistic, the same reason Queue.tsx keeps its own `sent` set: the
  // roster is pushed by the daemon and does not catch up to an answer
  // instantly, and sitting on a decision you just sent would be wrong even
  // for the one render it took.
  const [justAnswered, setJustAnswered] = useState<ReadonlySet<string>>(new Set());

  const waiting = rows.filter((row) => isWaiting(row) && !justAnswered.has(waitingKey(row)));

  // Land on whatever is waiting the moment there is nothing else in front of
  // you and you have not asked to browse. Re-checked on every roster push
  // rather than only on mount: the first thing waiting on a cold roster
  // often has not arrived yet when this hook first runs. Gated on `narrow`:
  // this is the one piece of the phone build that is not just CSS, so it is
  // the one piece that has to gate itself - above the breakpoint, opening
  // the app is not supposed to change who is selected at all.
  useEffect(() => {
    if (!narrow || selectedId !== null || seenRoster || waiting.length === 0) return;
    rawSelect(waiting[0].id);
    // Deliberately keyed on `rows` rather than `waiting`: the filtered array
    // is a new reference every render, which would run this on every roster
    // push regardless of whether anything it looks at changed.
  }, [narrow, rows, selectedId, seenRoster, rawSelect]);

  const select = useCallback((id: string | null) => {
    setSeenRoster(true);
    rawSelect(id);
  }, [rawSelect]);

  const browseRoster = useCallback(() => {
    setSeenRoster(true);
    rawSelect(null);
  }, [rawSelect]);

  const advance = useCallback((row: RosterRow) => {
    setJustAnswered((current) => new Set(current).add(waitingKey(row)));
    const next = waiting.find((candidate) => candidate.id !== row.id) ?? null;
    rawSelect(next?.id ?? null);
  }, [waiting, rawSelect]);

  // Above the breakpoint this is exactly what selectedId ? "stage" : "roster"
  // always was - #unblock and #empty are phone screens, and pane never
  // claims to be either one where there is no phone to show them on.
  const pane: PhonePane = !narrow
    ? (selectedId === null ? "roster" : "stage")
    : selectedId === null
      ? (seenRoster ? "roster" : (waiting.length > 0 ? "unblock" : "empty"))
      : (seenRoster ? "stage" : "unblock");

  return { pane, select, browseRoster, waitingCount: waiting.length, advance };
}
