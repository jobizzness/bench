import type { Decision } from "../../shared/types.js";

/**
 * The plain decision: one question, a keycap per answer. An intake replaces
 * this whole row, so the two are never on screen together.
 */
export function DecisionOptions({
  decision, choice, onChoose, id = "decision-options",
}: {
  decision: Decision;
  choice: string | null;
  onChoose: (id: string) => void;
  /** The queue renders a second set of these, and two elements cannot share
   * an id. The class is what carries the layout. */
  id?: string;
}) {
  return (
    <div id={id} className="options">
      {decision.options.map((option, index) => (
        <button
          type="button"
          className="option"
          key={option.id}
          aria-pressed={choice === option.id}
          onClick={() => onChoose(option.id)}
        >
          <span className="key">{index + 1}</span>
          <span>
            <span className="label">{option.label}</span>
            {option.hint && <span className="hint">{option.hint}</span>}
          </span>
        </button>
      ))}
    </div>
  );
}
