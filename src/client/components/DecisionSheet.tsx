import { useEffect, useRef, useState } from "react";
import type { Decision, RosterRow } from "../../shared/types.js";
import { postJson } from "../api.js";
import { answersFor } from "../../shared/decisions.js";
import { projectName } from "../format.js";
import { DecisionOptions } from "./DecisionOptions.js";
import { UnblockSkeleton } from "./UnblockSkeleton.js";
import { useReportFrame } from "./useReportFrame.js";
import { useSheetDismissGestures } from "./useSheetDismissGestures.js";

/**
 * A waiting specialist's decision, in a sheet over the roster - the report
 * and the options it justifies, in one column, answerable without leaving
 * the roster behind it (#90).
 *
 * This used to be `PhoneUnblock`, a full-screen pane that replaced `#app`
 * entirely - the same complaint #83 fixed for arrival (a screen with no
 * sense of what else exists reads as being taken somewhere), left in place
 * for the tap. Now it is a `<dialog>`, always mounted rather than
 * conditionally rendered: `App.tsx` toggles `open` and this component stays
 * alive underneath, which is what lets a dismissed decision keep its choice
 * and typed text if the same one is reopened in the same session (#60's
 * precedent) - a component that unmounted on close would have nowhere to
 * keep them. `row` is nullable for exactly that reason: it is whatever was
 * last selected, including nothing, while this stays mounted regardless.
 *
 * Handed a decision that has already been fetched (`App.tsx` calls the same
 * `useDecision` the desktop stage does) rather than fetching its own - the
 * report itself is the only thing this component goes and gets for itself,
 * because nothing else already holds it. An intake is never handed to this
 * component at all: it wants the whole page, and gets the ordinary stage
 * instead (see `App.tsx`'s `decisionSheetOpen`).
 *
 * Dismissible three ways (#91): the `Roster` button below, a tap on the
 * dimmed roster behind it, and a downward drag - all three call this same
 * `onClose`, so `selectedId` and the URL never have two different ideas
 * about whether this is open. The tap and the drag are `useSheetDismissGestures`,
 * built shareable across every `.sheet` rather than specific to this one
 * (#81's own reasoning for the CSS) - wired in here only, for now. The other
 * `.sheet` dialogs (intake, dispatch, settings, new-session) all rise from
 * the same bottom edge below 720px but were left without the gesture: none
 * of them were asked for by #91, and dispatch and settings in particular
 * have their own inline forms with their own scroll areas that deserve the
 * same deliberate look this one got rather than an untested assumption that
 * the hook behaves identically there. Follow-up, not silent scope.
 */
export function DecisionSheet({ open, row, decision, decisionSettled = true, waitingCount, onAnswered, onClose }: {
  open: boolean;
  row: RosterRow | null;
  /** null while the report is still loading. */
  decision: Decision | null;
  /** Whether the fetch behind `decision` has answered yet - see
   * `useDecision.ts`. Defaults to true so a caller that already has its
   * decision in hand (tests, mainly) does not have to say so. False draws
   * `UnblockSkeleton` instead of the bare header this screen used to show
   * for the length of that fetch (#80). */
  decisionSettled?: boolean;
  /** Including this one, so "1 of 2" reads as "here, and one more after." */
  waitingCount: number;
  /** The answer posted; the caller decides what comes next. */
  onAnswered: () => void;
  /** Dismiss, or the dialog's own native close (Esc, or the back gesture
   * popping `selectedId` back out of the URL - see `App.tsx`). Always the
   * one door: whichever way this closes, `App.tsx` deselects, so the URL
   * and the sheet's open state can never drift apart (#90). */
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [choice, setChoice] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // What `open` was as of the last render, read inside the dialog's own
  // `close` event - which fires whenever this closes, including the times
  // `App.tsx` closes it on its own (an intake or a hand-off taking over,
  // `onAnswered` moving on). Only a close that happens while this ref still
  // says "open" is one nobody told the dialog to do - Esc, or a browser's
  // own back-gesture integration - and only that one should count as the
  // developer dismissing it (`onClose`, below). Otherwise `App.tsx` already
  // knows why this closed and `selectedId` does not need touching for it.
  const openRef = useRef(open);
  useEffect(() => { openRef.current = open; }, [open]);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open) { if (!dialog.open) dialog.showModal?.(); }
    else if (dialog.open) dialog.close?.();
  }, [open]);

  useSheetDismissGestures(ref, onClose);

  // A fresh decision starts with nothing chosen - without this, answering
  // one and landing on the next would carry the previous pick with it.
  // Keyed on the report rather than on mount: this component never unmounts
  // while dismissed (see the class comment), so `row` becoming null and then
  // the same row coming back must not read as a new decision and clear what
  // was chosen - only an actually different report does.
  const lastKey = useRef<string | null>(null);
  useEffect(() => {
    if (!row) return;
    const key = `${row.id}:${row.latestReportSeq}`;
    if (key === lastKey.current) return;
    lastKey.current = key;
    setChoice(null);
    setText("");
    setError(null);
  }, [row]);

  // isWaiting(row) is what put this row in front of you in the first place
  // (usePhoneLanding.ts), and that guarantees latestReportSeq is not null
  // while `row` is set; the fallbacks here only matter for the type and for
  // the dialog sitting dismissed with nothing selected, never for what
  // actually renders while open.
  const { content, failed: reportFailed, frameLoaded, frameRef, onFrameLoad } =
    useReportFrame(row?.id ?? "", row?.latestReportSeq ?? 0);

  const send = async () => {
    if (!row || busy || (!choice && text.trim() === "")) return;
    setBusy(true);
    setError(null);
    try {
      const res = await postJson(`/api/sessions/${row.id}/answer`, { optionId: choice, text: text.trim() });
      if (!res.ok) throw new Error(`answer failed: ${res.status}`);
      onAnswered();
    } catch {
      // choice and text are untouched above, so the retry this invites does
      // not ask the developer to type the answer again (#60).
      setError("Didn't send. Check the connection and try again.");
    } finally {
      setBusy(false);
    }
  };

  const options = decision ? answersFor(decision) : [];

  return (
    // Escape fires `close` natively, and so does the back gesture on
    // whatever browser support for it lands first - either way only calls
    // `onClose` if this was not already closing on `App.tsx`'s own say-so
    // (see the `openRef` comment above).
    <dialog id="unblock" className="sheet" ref={ref} onClose={() => { if (openRef.current) onClose(); }}>
      {/* Gated on `open`, not only on `row`: this component stays mounted
          the whole time (see the class comment) so a dismissed decision
          keeps its `choice`/`text` in memory, but the dialog's *content*
          rendering while closed - above 720px it is never eligible at all
          (#90) - is a second, fully wired copy of the same options sitting
          in the document underneath the desktop composer's own, reachable
          by anything that is not scoped to a visible container. */}
      {open && row && (
        <>
          {/* The only hint the drag-to-dismiss gesture exists at all
              (#91) - every native sheet has one, and without it there is
              nothing on screen to suggest the sheet can be pulled. */}
          <div className="sheet-grabber" aria-hidden="true" />
          <header id="unblock-head">
            <span className="eyebrow">{projectName(row.project)} · {row.label}</span>
            {waitingCount > 1 && <span id="unblock-count">1 of {waitingCount}</span>}
            <button type="button" id="unblock-roster" onClick={onClose}>Roster</button>
          </header>

          {!decisionSettled ? <UnblockSkeleton /> : decision && (
            <>
              <strong id="unblock-title">{decision.title}</strong>
              <p id="unblock-summary">{decision.summary}</p>

              <div id="unblock-report">
                {/* Reserves the report's space until it is known - the fetch
                    that finds it, and then the frame's own load, which is the
                    thing that used to resize visibly out from under a report
                    already on screen (#80). */}
                {!reportFailed && !frameLoaded && <div className="skeleton frame-skeleton" aria-hidden="true" />}
                {content?.kind === "url" && (
                  <iframe
                    id="unblock-frame" className={frameLoaded ? undefined : "frame-loading"}
                    ref={frameRef} onLoad={onFrameLoad}
                    sandbox="allow-same-origin" title="Report" src={content.url}
                  />
                )}
                {content?.kind === "html" && (
                  <iframe
                    id="unblock-frame" className={frameLoaded ? undefined : "frame-loading"}
                    ref={frameRef} onLoad={onFrameLoad}
                    sandbox="allow-same-origin" title="Report" srcDoc={content.html}
                  />
                )}
                {reportFailed && (
                  <p id="unblock-report-failed" role="alert">
                    Couldn't load the report. The options below still work.
                  </p>
                )}
              </div>

              <DecisionOptions id="unblock-options" decision={decision} choice={choice} onChoose={setChoice} />
              {error && <p id="unblock-error" role="alert">{error}</p>}
              <div id="unblock-send">
                <input
                  id="unblock-text"
                  autoComplete="off"
                  placeholder={options.length > 0 ? "Or say it in your own words" : "Your answer"}
                  value={text}
                  onChange={(event) => setText(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key !== "Enter") return;
                    event.preventDefault();
                    void send();
                  }}
                />
                <button
                  type="button" id="unblock-answer"
                  disabled={busy || (!choice && text.trim() === "")}
                  onClick={() => void send()}
                >
                  Answer
                </button>
              </div>
              {waitingCount > 1 && <p id="unblock-foot">{waitingCount - 1} more waiting after this.</p>}
            </>
          )}
        </>
      )}
    </dialog>
  );
}
