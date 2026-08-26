/**
 * The models a specialist can be run on.
 *
 * Two kinds, told apart by a slash.
 *
 * Anthropic's are the aliases `claude --model` takes, not pinned model names:
 * an alias follows the latest release, which is what you want a bench of
 * long-lived specialists pointed at. The resolved name is carried alongside
 * so the cockpit can show what an alias means today rather than asking you to
 * know - it was read out of the CLI, by running each one. These go straight
 * to Anthropic on whatever login the machine already has.
 *
 * Everything else is an OpenRouter id - `google/gemini-3.7-flash` - and is
 * not listed here at all. That list is fetched from OpenRouter, because a
 * hand-maintained one is a list that goes stale silently: this file once
 * named Gemini models that no longer existed while the ones people wanted
 * were missing, and nothing about it looked wrong. See daemon/openrouter.ts.
 */
export interface Model {
  /** What is passed to `claude --model`. */
  id: string;
  label: string;
  /** What the alias resolved to when this list was last checked. */
  resolves: string;
}

export const MODELS: readonly Model[] = [
  { id: "opus", label: "Opus 5", resolves: "claude-opus-5" },
  { id: "sonnet", label: "Sonnet 5", resolves: "claude-sonnet-5" },
  { id: "fable", label: "Fable 5", resolves: "claude-fable-5" },
  { id: "haiku", label: "Haiku 4.5", resolves: "claude-haiku-4-5-20251001" },
];

/** What a specialist runs on unless someone says otherwise. */
export const DEFAULT_MODEL = "opus";

/**
 * Whether this bench will accept the name.
 *
 * An OpenRouter id is accepted on its shape rather than checked against the
 * catalogue: the catalogue is a network call, this is called on every save,
 * and a model that OpenRouter has never heard of comes back as its own clear
 * error from the one place that can actually say so.
 */
export function isModelId(value: unknown): value is string {
  if (typeof value !== "string" || value === "") return false;
  return MODELS.some((m) => m.id === value) || value.includes("/");
}

/** Whether the model is reached through OpenRouter rather than direct. */
export function isProxied(id: string): boolean {
  return id.includes("/");
}

/**
 * A model is not refused for being unknown to this list. The CLI takes full
 * model names too, and a record written before a model was added still has to
 * open - so an unrecognised one is shown as itself rather than replaced.
 *
 * An OpenRouter id is shown without its vendor prefix, because the vendor is
 * already how the picker groups them and repeating it in every row is noise:
 * `google/gemini-3.7-flash` reads as "gemini-3.7-flash" under a Google
 * heading.
 */
export function modelLabel(id: string): string {
  const known = MODELS.find((m) => m.id === id);
  if (known) return known.label;
  const slash = id.indexOf("/");
  return slash === -1 ? id : id.slice(slash + 1);
}
