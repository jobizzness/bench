import { useCallback, useEffect, useRef, useState } from "react";
import type { RosterRow } from "../../shared/types.js";
import { tap } from "../haptics.js";
import { waitingKey, wantsAttention } from "../waiting.js";
import { useNarrowViewport } from "./useNarrowViewport.js";

/** How long the bench-clear settle (#93) holds before it lets go - long
 * enough to read as a deliberate pause, not another 200ms micro-transition.
 * Kept here rather than as a CSS custom property: nothing else needs this
 * number, and `tests/themes.test.ts` asserts the exact `:root` token list. */
const SETTLE_MS = 900;

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
  /** Marks `row` answered without moving the selection - what `DecisionSheet`
   * calls the instant its POST succeeds, before its own exit motion plays, so
   * the row underneath starts settling into its working look at the tap
   * rather than waiting for `advance` to also change what is selected (#93).
   * `advance` calls this itself, so a caller that does not need the two
   * split apart can still just call `advance` alone. */
  markAnswered: (row: RosterRow) => void;
  /** Reads `waitingKey`-shaped identity, not just `row.id`: a specialist
   * that answered and then got a genuinely new report must not still read as
   * settled. Exposed so `Row.tsx` can paint the same optimism this hook
   * already uses to decide what still counts as waiting (#93). */
  justAnswered: ReadonlySet<string>;
  /** True for one deliberate beat after `advance` finds nothing left to move
   * on to - the bench clearing (#93). Never true because of a fresh page
   * load or a re-render; only the crossing inside `advance` itself sets it,
   * and it clears itself again on a timer. */
  justCleared: boolean;
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
  // The bench-clear settle (#93) - true for one deliberate beat, set only by
  // the crossing inside `advance` below and never by render or mount.
  const [justCleared, setJustCleared] = useState(false);
  const clearedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (clearedTimer.current) clearTimeout(clearedTimer.current); }, []);

  // `wantsAttention`, not `isWaiting`: a tab another specialist opened and
  // handed a prompt to is held on the developer exactly as hard as an
  // unanswered decision is, but it has no report, so `isWaiting` is false for
  // it. Filtering on that was why a phone with a sub-agent waiting to be
  // dispatched showed the "nothing waiting" screen (#75) - it is now a row
  // on the roster like any other, rather than something navigated to.
  const waiting = rows.filter((row) => wantsAttention(row) && !justAnswered.has(waitingKey(row)));

  const browseRoster = useCallback(() => {
    tap();
    rawSelect(null);
  }, [rawSelect]);

  const markAnswered = useCallback((row: RosterRow) => {
    setJustAnswered((current) => new Set(current).add(waitingKey(row)));
  }, []);

  const advance = useCallback((row: RosterRow) => {
    markAnswered(row);
    const next = waiting.find((candidate) => candidate.id !== row.id) ?? null;
    if (next === null) {
      // The last one - the bench clears. One deliberate beat, then quiet
      // again; a flag left set would replay as soon as the next `advance`
      // call happened to find nothing too, which is exactly right, but
      // leaving it set *between* crossings would also make it true the next
      // time this component merely re-rendered, which is not a crossing at
      // all (#93's own rule: state-tracked, not inferred from render).
      setJustCleared(true);
      if (clearedTimer.current) clearTimeout(clearedTimer.current);
      clearedTimer.current = setTimeout(() => setJustCleared(false), SETTLE_MS);
    }
    rawSelect(next?.id ?? null);
  }, [waiting, rawSelect, markAnswered]);

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
    markAnswered,
    justAnswered,
    justCleared,
  };
}
