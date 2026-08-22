import type { IntakeOption, IntakeQuestion as Question } from "../../shared/types.js";
import {
  answerFor, questionState, STATE_CHIP, type Answers,
} from "../intake.js";

function Option({
  option, question, answers, showKey, position, onPick,
}: {
  option: IntakeOption;
  question: Question;
  answers: Answers;
  showKey: boolean;
  position: number;
  onPick: () => void;
}) {
  return (
    <button
      type="button"
      className="option"
      aria-pressed={answerFor(answers, question).ids.includes(option.id)}
      onClick={onPick}
    >
      {/* Keycaps only where a key would work: the folded questions are mouse
          territory, and a number on them would be a promise the app breaks. */}
      {showKey && position < 9 && <span className="key">{position + 1}</span>}
      <span>
        <span className="label">{option.label}</span>
        {/* The specialist's own pick, named as such. An answer you did not
            give should never look like one you did. */}
        {option.default && <span className="mine">mine</span>}
        {option.hint && <span className="hint">{option.hint}</span>}
      </span>
    </button>
  );
}

/** One question: what it asks, what turns on the answer, and the way out. */
export function IntakeQuestion({
  question, answers, ordinal, focused, onPick, onWrite,
}: {
  question: Question;
  answers: Answers;
  /** Its number in the open list, or null inside the folded group. */
  ordinal: number | null;
  focused: boolean;
  onPick: (optionId: string) => void;
  onWrite: (text: string) => void;
}) {
  const state = questionState(answers, question);

  return (
    <section
      className="question"
      data-state={state}
      data-focused={ordinal === null ? undefined : focused}
    >
      <div className="q-head">
        {ordinal !== null && <span className="q-ordinal">{ordinal + 1}</span>}
        <span className="q-ask">{question.ask}</span>
        <span className="q-chip">{STATE_CHIP[state]}</span>
      </div>

      {question.why && <p className="q-why">{question.why}</p>}

      <div className="q-options">
        {question.options.map((option, position) => (
          <Option
            key={option.id}
            option={option}
            question={question}
            answers={answers}
            showKey={ordinal !== null && focused}
            position={position}
            onPick={() => onPick(option.id)}
          />
        ))}
      </div>

      {question.allowFreeText && (
        <input
          type="text"
          className="q-text"
          autoComplete="off"
          placeholder="or say it your own way"
          aria-label={`Answer in your own words: ${question.ask}`}
          value={answerFor(answers, question).text}
          onChange={(event) => onWrite(event.target.value)}
        />
      )}
    </section>
  );
}
