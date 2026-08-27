import { comparisonLabel, dollars, perMillionLabel, type Price } from "../../shared/cost.js";

/** One model in the picker, as much of it as the daemon hands over. */
export interface Listed {
  id: string;
  name: string;
  vendor: string;
  contextLength: number | null;
  price: Price;
}

/**
 * One row: what it is, what it holds, and what it would cost you.
 *
 * Two facts a line, in two columns. What the model is on the left, what it
 * costs on the right, and the eye runs down either column without reading the
 * other.
 *
 * The row used to carry six figures: three catalogue rates per million, the
 * estimate, and a bare ratio - four different ways of saying one thing, in
 * units nobody converts in their head, with the number that meant "cheaper"
 * looking exactly like the number that meant "dearer". Now it says what a
 * turn costs and how that compares, in words. The rates are still there for
 * anyone who wants them, on the row's own tooltip, which is where a reference
 * figure belongs when it is not the thing being decided.
 */
export function ModelRow({ model, at, active, current, disabled, turn, multiple, onPick, onHover }: {
  model: Listed;
  /** Its place in the list, which is how the arrow keys refer to it. */
  at: number;
  active: boolean;
  current: boolean;
  disabled: boolean;
  /** What a turn like the developer's would cost here, or null when the
   * catalogue does not quote enough to say. */
  turn: number | null;
  /** That cost against the model the specialist is on now. */
  multiple: number | null;
  onPick: () => void;
  onHover: () => void;
}) {
  return (
    <button
      type="button"
      role="option"
      className="model-row"
      data-model={model.id}
      data-at={at}
      data-current={current}
      data-active={active}
      aria-selected={current}
      aria-current={current}
      disabled={disabled}
      title={rates(model.price)}
      onMouseEnter={onHover}
      onClick={onPick}
    >
      <b>{shortName(model)}</b>
      <span className="model-id">{model.id}</span>
      {/* The number that answers the question, and the only loud thing here.
          "Not quoted" rather than nothing, and never zero: a model billed per
          request drawn as free is the one mistake this row exists to
          prevent. */}
      <span className="model-turn">{turn === null ? "not quoted" : dollars(turn)}</span>
      {/* Amber only for materially dearer than what you are on. The cheap
          ones are the good case and do not need alerting; a picker that
          colours every row has no colour left for the one worth noticing. */}
      <span className="model-versus" data-dear={multiple !== null && multiple >= 2}>
        {current ? "what you are on" : comparisonLabel(multiple)}
      </span>
      <span className="model-window">{windowLabel(model.contextLength)}</span>
    </button>
  );
}

/**
 * The catalogue rates, for the tooltip.
 *
 * Written out in words rather than as three figures separated by dots: a
 * tooltip is read once, by somebody who wants the detail, and "$0.08 for
 * fresh input" needs no legend to go with it.
 */
function rates(price: Price): string {
  if (price.fresh === null && price.out === null) return "This one is not priced per token.";
  return `Per million tokens: ${perMillionLabel(price.fresh)} fresh input, `
    + `${perMillionLabel(price.cacheRead)} cached, ${perMillionLabel(price.out)} output.`;
}

/**
 * The model's own name, with the vendor taken off the front.
 *
 * OpenRouter names every model "Google: Gemini 3.7 Flash". Under a Google
 * heading, next to the id `google/gemini-3.7-flash`, that is the third time
 * the reader has been told who makes it.
 */
export function shortName(model: Listed): string {
  const colon = model.name.indexOf(": ");
  return colon === -1 ? model.name : model.name.slice(colon + 2);
}

/**
 * The window, in the units people say it in.
 *
 * A megabyte-ish million and a round million both read as "1M". They used to
 * come out as "1.0M" and "1M" in the same column, which is the kind of jitter
 * that makes a tidy column look like a mistake.
 */
export function windowLabel(length: number | null): string {
  if (length === null) return "";
  if (length < 1_000_000) return `${Math.round(length / 1000)}k`;
  return `${(length / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
}
