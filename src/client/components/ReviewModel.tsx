import { MODELS } from "../../shared/models.js";

/**
 * Which model argues with your specialists.
 *
 * Every other session on this bench is opened by you, with the model chosen
 * in front of you. The reviewer is the exception - "Review this" opens it
 * from a report, with no dialog in the way - so the choice has to have been
 * made in advance, once, here.
 *
 * It is a real choice rather than a preference: a reviewer reads a diff and
 * tries to break the claims in a report, which is a different job from
 * writing the code, and the model that is best at one is not automatically
 * the one you want doing the other to every branch you produce.
 */
export function ReviewModel({ value, onChange }: {
  value: string;
  onChange: (id: string) => void;
}) {
  const resolves = MODELS.find((m) => m.id === value)?.resolves;

  return (
    <section id="s-review">
      <label htmlFor="s-review-model">Review model</label>
      <select
        id="s-review-model"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        {MODELS.map((model) => (
          <option value={model.id} key={model.id}>{model.label}</option>
        ))}
      </select>
      <p className="field-note" id="s-review-note">
        What <b>Review this</b> opens its reviewer on. Specialists keep the
        model they were made with; this is only the second pair of eyes.
        {resolves && <> The alias follows the latest release — today <code>{resolves}</code>.</>}
      </p>
    </section>
  );
}
