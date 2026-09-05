import { useEffect, useState } from "react";
import type { Decision, RosterRow } from "../../shared/types.js";
import { postJson } from "../api.js";
import { answersFor } from "../../shared/decisions.js";
import { projectName } from "../format.js";
import { DecisionOptions } from "./DecisionOptions.js";
import { UnblockSkeleton } from "./UnblockSkeleton.js";
import { useReportFrame } from "./useReportFrame.js";

/**
 * The phone's front door when something is waiting: the report and the
 * options it justifies, in one column, answerable without leaving the
 * screen.
 *
 * Handed a decision that has already been fetched (`App.tsx` calls the same
 * `useDecision` the desktop stage does) rather than fetching its own - the
 * report itself is the only thing this component goes and gets for itself,
 * because nothing else already holds it. An intake is never handed to this
 * component at all: it wants the whole page, and gets the ordinary stage
 * instead (see `App.tsx`'s `effectivePane`).
 */
export function PhoneUnblock({ row, decision, decisionSettled = true, waitingCount, onAnswered, onBrowseRoster }: {
  row: RosterRow;
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
  onBrowseRoster: () => void;
}) {
  const [choice, setChoice] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // A fresh decision starts with nothing chosen - without this, answering
  // one and landing on the next would carry the previous pick with it.
  useEffect(() => { setChoice(null); setText(""); setError(null); }, [row.id]);

  // isWaiting(row) is what put this row in front of you in the first place
  // (usePhoneLanding.ts), and that guarantees latestReportSeq is not null;
  // the fallback here only matters for the type, never for what actually
  // renders.
  const { content, failed: reportFailed, frameLoaded, frameRef, onFrameLoad } =
    useReportFrame(row.id, row.latestReportSeq ?? 0);

  const send = async () => {
    if (busy || (!choice && text.trim() === "")) return;
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
    <section id="unblock">
      <header id="unblock-head">
        <span className="eyebrow">{projectName(row.project)} · {row.label}</span>
        {waitingCount > 1 && <span id="unblock-count">1 of {waitingCount}</span>}
        <button type="button" id="unblock-roster" onClick={onBrowseRoster}>Roster</button>
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
    </section>
  );
}
