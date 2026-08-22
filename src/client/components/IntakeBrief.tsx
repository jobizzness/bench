import type { Decision } from "../../shared/types.js";
import { briefSegments, type Answers } from "../intake.js";

/**
 * Figure spaces, not ordinary ones: HTML collapses a run of plain spaces to
 * nothing, leaving no width for the underline to draw. A slot with no answer
 * is a blank to fill — "resets ____ to the audit trail" reads as a sentence,
 * "resets — to the audit trail" reads as a bug.
 */
const BLANK = "     ";

/** One sentence with `{questionId}` holes, filled as the developer answers. */
export function IntakeBrief({ decision, answers }: { decision: Decision; answers: Answers }) {
  if (!decision.brief) return null;

  return (
    <p id="intake-brief">
      {briefSegments(decision, answers).map((segment, index) => {
        if (segment.kind === "text") return segment.text;
        if (segment.kind === "missing") {
          return <span className="slot" data-state="missing" key={index}>{segment.text}</span>;
        }
        return (
          <span
            className="slot"
            data-state={segment.state}
            title={segment.ask}
            aria-label={segment.text || `${segment.ask} — unanswered`}
            key={index}
          >
            {segment.text || BLANK}
          </span>
        );
      })}
    </p>
  );
}
