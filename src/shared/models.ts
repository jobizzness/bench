/**
 * The models a specialist can be run on.
 *
 * These are the aliases `claude --model` takes, not pinned model names: an
 * alias follows the latest release, which is what you want a bench of
 * long-lived specialists pointed at. The resolved name is carried alongside
 * so the cockpit can show what an alias means today rather than asking you to
 * know - it was read out of the CLI, by running each one.
 *
 * A list rather than a lookup: there is no command that asks Claude Code what
 * it supports, so this is maintained by hand and checked against the CLI.
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

export function isModelId(value: unknown): value is string {
  return typeof value === "string" && MODELS.some((m) => m.id === value);
}

/**
 * A model is not refused for being unknown to this list. The CLI takes full
 * model names too, and a record written before a model was added still has to
 * open - so an unrecognised one is shown as itself rather than replaced.
 */
export function modelLabel(id: string): string {
  return MODELS.find((m) => m.id === id)?.label ?? id;
}
