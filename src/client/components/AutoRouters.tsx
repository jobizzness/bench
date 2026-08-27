import { AUTO_ROUTERS, isAutoRouter } from "../../shared/auto-routers.js";

export { AUTO_ROUTERS, isAutoRouter };

/**
 * Let OpenRouter pick the model, per request.
 *
 * Its own block above the catalogue rather than two rows inside it, because
 * these are not models and do not belong in a list sorted by price: they have
 * no price until they have chosen. Putting them in the priced column would
 * mean two rows reading "not quoted" among three hundred that quote, which
 * looks like a gap in our data rather than the truth about a router.
 *
 * The cost of that honesty is stated rather than hidden. Bench prices a turn
 * before you spend it and records what it cost afterwards; on these it can do
 * neither, and a developer choosing one should know that is the trade they
 * are making rather than discover it from an empty ledger.
 */
export function AutoRouters({ current, disabled, onPick }: {
  current: string;
  disabled: boolean;
  onPick: (model: string) => void;
}) {
  return (
    <section className="model-house model-auto" data-house="auto">
      <h3>Route each request</h3>
      <p className="field-note" data-house-note="auto">
        OpenRouter picks the model for every request, on what the prompt looks
        like. Bench cannot quote a turn on these in advance or record what one
        cost afterwards — the price is not known until the router has
        chosen.{" "}
        <a href="https://openrouter.ai/docs/features/model-routing" target="_blank" rel="noreferrer">
          Learn more
        </a>
      </p>
      <div className="model-options">
        {AUTO_ROUTERS.map((router) => (
          <button
            type="button"
            key={router.id}
            className="model-option"
            data-model={router.id}
            data-current={router.id === current}
            aria-current={router.id === current}
            disabled={disabled}
            onClick={() => onPick(router.id)}
          >
            <b>{router.label}</b>
            <span>{router.note}</span>
          </button>
        ))}
      </div>
    </section>
  );
}
