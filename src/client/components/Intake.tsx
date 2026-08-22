import { useEffect, useRef } from "react";
import type { Decision, IntakeQuestion as Question } from "../../shared/types.js";
import {
  answerFor, labelsFor, pickOption, splitQuestions, writeText, type Answers,
} from "../intake.js";
import { IntakeBrief } from "./IntakeBrief.js";
import { IntakeQuestion } from "./IntakeQuestion.js";

/** Everything the specialist could guess and nobody needs to see, in one line. */
function Assumed({
  questions, answers, onPick, onWrite,
}: {
  questions: Question[];
  answers: Answers;
  onPick: (question: Question, optionId: string) => void;
  onWrite: (question: Question, text: string) => void;
}) {
  if (questions.length === 0) return null;

  const preview = questions
    .map((q) => labelsFor(answers, q).join(" and ") || answerFor(answers, q).text.trim() || "—")
    .join(" · ");

  return (
    <details id="intake-assumed">
      <summary>
        <span id="intake-assumed-count">{questions.length} more I've already assumed</span>
        <span id="intake-assumed-preview">{preview}</span>
      </summary>
      <div id="intake-assumed-questions">
        {questions.map((question) => (
          <IntakeQuestion
            key={question.id}
            question={question}
            answers={answers}
            ordinal={null}
            focused={false}
            onPick={(optionId) => onPick(question, optionId)}
            onWrite={(text) => onWrite(question, text)}
          />
        ))}
      </div>
    </details>
  );
}

export function Intake({
  decision, answers, setAnswers, focus, setFocus,
}: {
  decision: Decision;
  answers: Answers;
  setAnswers: (next: Answers) => void;
  focus: number;
  setFocus: (index: number) => void;
}) {
  const { open, assumed } = splitQuestions(decision);
  const host = useRef<HTMLDivElement>(null);

  // Keyboard focus can land on a question below the fold; the panel scrolls,
  // so it has to follow.
  useEffect(() => {
    host.current?.querySelector('[data-focused="true"]')
      ?.scrollIntoView?.({ block: "nearest", behavior: "smooth" });
  }, [focus]);

  const pick = (question: Question, optionId: string) =>
    setAnswers(pickOption(answers, question, optionId));
  const write = (question: Question, text: string) =>
    setAnswers(writeText(answers, question, text));

  return (
    <div id="intake" ref={host}>
      <IntakeBrief decision={decision} answers={answers} />

      <div id="intake-questions">
        {open.map((question, index) => (
          <IntakeQuestion
            key={question.id}
            question={question}
            answers={answers}
            ordinal={index}
            focused={index === focus}
            onPick={(optionId) => { setFocus(index); pick(question, optionId); }}
            onWrite={(text) => write(question, text)}
          />
        ))}
      </div>

      <Assumed questions={assumed} answers={answers} onPick={pick} onWrite={write} />
    </div>
  );
}
