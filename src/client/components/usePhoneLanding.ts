import { useCallback, useState } from "react";
import type { RosterRow } from "../../shared/types.js";
import { wantsAttention } from "../waiting.js";
import { useNarrowViewport } from "./useNarrowViewport.js";

export type PhonePane = "roster" | "stage";

export interface PhoneLanding {
  /** Which of the phone's screens is in front of the developer. Read by
   * `App.tsx` alongside `selectedId` to decide what to render; ignored
   * above the breakpoint, where every rule that acts on it lives inside
   * `@media (max-width: 720px)`. Never "the decision" any more (#90) - a
   * waiting row tapped on a phone opens `DecisionSheet` *over* whichever of
   * these two is already showing, rather than being a third one itself. */
  pane: PhonePane;
  /** Whether tapping the current selection is why a decision sheet should be
   * open - a row that is both selected and waiting, on a phone. `App.tsx`
   * ANDs this with its own overrides (an intake wants the whole stage; a
   * held hand-off wants the dispatch modal) rather than this hook knowing
   * about either. Named apart from `pane` because the sheet floats over
   * whichever pane is showing rather than being one (#90) - the roster
   * underneath is not navigated away from to show it. */
  sheetEligible: boolean;
  /** The row selector, unchanged - kept on `PhoneLanding` rather than handed
   * back raw so every caller reaches for one name regardless of width (see
   * `App.tsx`). Nothing below the breakpoint needs to know it was tapped
   * rather than steered here any more (#83). */
  select: (id: string | null) => void;
  /** Deselects. What the decision sheet's dismiss calls - closing it loses
   * nothing (the sheet keeps its own choice/text alive while dismissed, see
   * `DecisionSheet.tsx`) and lands back on the plain roster/stage view,
   * since nothing is auto-selected on this phone any more. */
  browseRoster: () => void;
  /** How many want the developer, including whichever one is in front of you
   * and counting a tab held on a hand-off - already discounting whatever you
   * answered this session but the roster has not caught up to yet (see
   * `justAnswered` below). */
  waitingCount: number;
  /** Call once `row`'s answer has posted. Moves on to whatever else is
   * waiting, or leaves the roster in front of you if that was the last one. */
  advance: (row: RosterRow) => void;
}

/** A row's report, not just the row - answering it and then getting a new
 * report on the same specialist is a different decision, and should not
 * still read as the one already answered. A tab held on a hand-off has no
 * report, so its key is stable; nothing calls `advance` for one (it is
 * dispatched, not answered), so that never has to tell two apart. */
function waitingKey(row: RosterRow): string {
  return `${row.id}:${row.latestReportSeq}`;
}

/**
 * Where the phone opens, and what moves it on from there.
 *
 * It opens on the roster, selecting nothing - the same front door as above
 * the breakpoint. #57 had this hook put whatever was waiting in front of the
 * developer instead, reasoning that a roster you would then have to navigate
 * out of was the wrong door for an unblocking device. That read fine in
 * review and wrong from a phone: landing straight onto a report with no
 * sense of what else exists is being dropped somewhere, not arriving
 * somewhere - and it was worse than that in practice, because the roster is
 * the one thing the app has data for first, so the cold-open sequence was
 * the empty screen's lie, then a flash to whatever the first push turned
 * out to hold (#80, #83).
 *
 * What #57 got right and this keeps: something waiting is not a screen you
 * go find. `.row[data-waiting="true"]` already carries a tinted background
 * and a rail wide and warm enough to spot from across the room (see
 * styles.css and #79's crossing animation) - tapping it is what opens a
 * decision sheet, and answering one still moves straight to the next
 * without a detour back through the roster in between (`advance`, below).
 *
 * Tapping used to replace the whole screen with the decision (the "unblock"
 * pane) - the same complaint #83 fixed for arrival, one level down (#90).
 * `pane` now only ever names the roster or the stage; the sheet floats over
 * whichever of those is already showing rather than being a third one.
 */
export function usePhoneLanding(
  rows: RosterRow[],
  selectedId: string | null,
  rawSelect: (id: string | null) => void,
): PhoneLanding {
  const narrow = useNarrowViewport();
  // Optimistic, the same reason Queue.tsx keeps its own `sent` set: the
  // roster is pushed by the daemon and does not catch up to an answer
  // instantly, and sitting on a decision you just sent would be wrong even
  // for the one render it took.
  const [justAnswered, setJustAnswered] = useState<ReadonlySet<string>>(new Set());

  // `wantsAttention`, not `isWaiting`: a tab another specialist opened and
  // handed a prompt to is held on the developer exactly as hard as an
  // unanswered decision is, but it has no report, so `isWaiting` is false for
  // it. Filtering on that was why a phone with a sub-agent waiting to be
  // dispatched showed the "nothing waiting" screen (#75) - it is now a row
  // on the roster like any other, rather than something navigated to.
  const waiting = rows.filter((row) => wantsAttention(row) && !justAnswered.has(waitingKey(row)));

  const browseRoster = useCallback(() => rawSelect(null), [rawSelect]);

  const advance = useCallback((row: RosterRow) => {
    setJustAnswered((current) => new Set(current).add(waitingKey(row)));
    const next = waiting.find((candidate) => candidate.id !== row.id) ?? null;
    rawSelect(next?.id ?? null);
  }, [waiting, rawSelect]);

  // The decision sheet is for a row that is actually holding the developer.
  // Landing on one and then having it stop - dispatched, declined, answered
  // from the laptop, crashed - used to leave `pane` on "unblock" anyway, and
  // that screen drew nothing but its own header once there was no decision
  // behind it (the sheet, being a dialog rather than a pane, just does not
  // open at all now that nothing is asking for it - there is no equivalent
  // to fall back from).
  const selectedWants = waiting.some((candidate) => candidate.id === selectedId);

  // Above the breakpoint this is exactly what selectedId ? "stage" : "roster"
  // always was, and stays that way regardless of `selectedWants` - the sheet
  // is a phone-only affordance (#90), and pane never claims to be it where
  // there is no phone to show it on. Below it, nothing selected is always
  // the roster (#83); a waiting row leaves the roster in front too, now
  // that tapping it opens a sheet over the pane rather than replacing it.
  const pane: PhonePane = selectedId === null
    ? "roster"
    : (narrow && selectedWants ? "roster" : "stage");

  return {
    pane,
    sheetEligible: narrow && selectedWants,
    select: rawSelect,
    browseRoster,
    waitingCount: waiting.length,
    advance,
  };
}
