import { dollars, multipleLabel, perMillionLabel, type Price } from "../../shared/cost.js";

/** One model in the picker, as much of it as the daemon hands over. */
export interface Listed {
  id: string;
  name: string;
  vendor: string;
  contextLength: number | null;
  price: Price;
}

/**
 * One row: what it is, what it holds, what it charges, and what a turn on it
 * would come to.
 *
 * The estimate is the loudest thing on the row and everything else is quiet,
 * because it is the only figure that answers the question the developer came
 * here with. The three catalogue prices are beside it in one cell rather than
 * three columns - fresh, cached, out - so a row stays a row, and they are
 * labelled once in the legend above the list rather than forty times down it.
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
      onMouseEnter={onHover}
      onClick={onPick}
    >
      <b>{shortName(model)}</b>
      <span className="model-id">{model.id}</span>
      <span className="model-window">{windowLabel(model.contextLength)}</span>
      <span className="model-prices">
        {perMillionLabel(model.price.fresh)}
        <i> · </i>{perMillionLabel(model.price.cacheRead)}
        <i> · </i>{perMillionLabel(model.price.out)}
      </span>
      {/* The number that answers the question. Empty rather than zero when the
          catalogue will not quote a price: a model billed per request drawn
          as free is the one mistake this whole row exists to prevent. */}
      <span className="model-turn" data-cheaper={multiple !== null && multiple < 0.95}>
        {turn === null ? "—" : dollars(turn)}
      </span>
      <span className="model-multiple">{multipleLabel(multiple)}</span>
    </button>
  );
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

/** The window, in the units people say it in. */
export function windowLabel(length: number | null): string {
  if (length === null) return "";
  return length >= 1_000_000
    ? `${(length / 1_000_000).toFixed(length % 1_000_000 === 0 ? 0 : 1)}M`
    : `${Math.round(length / 1000)}k`;
}
