import type { Decision } from "../../shared/types.js";
import type { Answers } from "../intake.js";
import { DecisionOptions } from "./DecisionOptions.js";
import { Intake } from "./Intake.js";

/** An intake is a decision with questions in it; everything else has options. */
export const isIntake = (decision: Decision | null): boolean =>
  Boolean(decision && decision.questions.length > 0);

export function DecisionPanel({
  decision, answers, setAnswers, focus, setFocus, choice, setChoice,
}: {
  decision: Decision;
  answers: Answers;
  setAnswers: (next: Answers) => void;
  focus: number;
  setFocus: (index: number) => void;
  choice: string | null;
  setChoice: (id: string) => void;
}) {
  const intake = isIntake(decision);

  return (
    <div id="decision" data-kind={decision.kind}>
      <div id="decision-head">
        {intake && <span id="decision-kind" className="eyebrow">before I build</span>}
        <strong id="decision-title">{decision.title}</strong>
        <span id="decision-summary">{decision.summary}</span>
      </div>

      {intake
        ? (
          <Intake
            decision={decision}
            answers={answers}
            setAnswers={setAnswers}
            focus={focus}
            setFocus={setFocus}
          />
        )
        : <DecisionOptions decision={decision} choice={choice} onChoose={setChoice} />}
    </div>
  );
}
