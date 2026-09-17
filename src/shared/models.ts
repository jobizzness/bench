import { isAutoRouter } from "./auto-routers.js";

/**
 * The models a specialist can be run on.
 *
 * Three kinds.
 *
 * Anthropic's are the aliases `claude --model` takes, not pinned model names:
 * an alias follows the latest release, which is what you want a bench of
 * long-lived specialists pointed at. The resolved name is carried alongside
 * so the cockpit can show what an alias means today rather than asking you to
 * know - it was read out of the CLI, by running each one. These go straight
 * to Anthropic on whatever login the machine already has.
 *
 * OpenRouter ids contain a slash (`google/gemini-3.7-flash`) and are not
 * listed here at all. That list is fetched from OpenRouter, because a
 * hand-maintained one is a list that goes stale silently: this file once
 * named Gemini models that no longer existed while the ones people wanted
 * were missing, and nothing about it looked wrong. See daemon/openrouter.ts.
 *
 * A third kind: local runtimes. These are bare ids with no slash, and they
 * are not in MODELS — they are neither Anthropic aliases nor OpenRouter ids.
 * `DEVIN_MODEL` ("devin") is the first. `isModelId` accepts them explicitly;
 * `isProxied` correctly returns false for them; `modelLabel` gives them a
 * human name.
 *
 * Devin's own models are namespaced under it: `devin:adaptive`,
 * `devin:opus`, `devin:swe-2` (#114). A colon, not a slash, on purpose -
 * `isProxied` treats any id containing `/` as an OpenRouter model, and a
 * slash here would make every Devin model demand an OpenRouter key. Bare
 * `devin` stays valid and means "the account default", so a record written
 * before this existed keeps working unchanged.
 */
export interface Model {
  /** What is passed to `claude --model`. */
  id: string;
  label: string;
  /** What the alias resolved to when this list was last checked. */
  resolves: string;
}

/**
 * The id for the Devin local runtime.
 *
 * Not in MODELS — it is neither an Anthropic alias nor an OpenRouter id. A
 * bare id with no slash, so `isProxied` correctly returns false and
 * `viaFor` returns undefined without needing an OpenRouter key.
 */
export const DEVIN_MODEL = "devin";

/** What namespaces a Devin model id: `devin:adaptive`, not `devin/adaptive`
 * — see the note on MODELS above for why the colon matters. */
export const DEVIN_PREFIX = "devin:";

/** Whether this id names the Devin runtime at all — the bare account
 * default or one of its namespaced families. The one place both spellings
 * are recognised together, so `runtimeFor` and `runningModelLabel` cannot
 * drift apart on what counts. */
export function isDevinModel(id: string): boolean {
  return id === DEVIN_MODEL || id.startsWith(DEVIN_PREFIX);
}

/**
 * The family to ask Devin for, from a namespaced id — `"adaptive"` from
 * `"devin:adaptive"`. `devin acp --model` takes this fuzzy family slug
 * directly (family, alias, or partial name) and resolves the effort variant
 * itself, which is the detail the picker offering families rather than all
 * 385 variants is deliberately not making the developer choose.
 *
 * Undefined for the bare account default and for anything not a Devin id —
 * both mean "nothing to override", which is what an absent `--model` is.
 */
export function devinFamilyOf(id: string): string | undefined {
  return id.startsWith(DEVIN_PREFIX) ? id.slice(DEVIN_PREFIX.length) : undefined;
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
 * The one sentence explaining what reasoning effort does, said the same way
 * everywhere it is offered - the model picker, the new-specialist form, and
 * Settings.
 *
 * It used to be three hand-written variants, each naming specific third-party
 * models (Gemini 3.1 Pro Preview/3.7 Pro, OpenAI o1/o3) rather than the thing
 * that actually determines whether it does anything: whether the model is
 * reached through OpenRouter. `reasoning-effort` is read in exactly one place,
 * the OpenRouter/Gemini proxy - see daemon/gemini.ts - so naming a vendor was
 * always going to go stale the next time OpenRouter added or dropped one.
 */
export const REASONING_EFFORT_NOTE =
  "Applies to models run through OpenRouter. Has no effect on Anthropic's own.";

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
  if (value.startsWith(DEVIN_PREFIX)) return value.length > DEVIN_PREFIX.length;
  return MODELS.some((m) => m.id === value) || value === DEVIN_MODEL || value.includes("/");
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
  if (id === DEVIN_MODEL) return "Devin";
  if (id.startsWith(DEVIN_PREFIX)) return `Devin: ${id.slice(DEVIN_PREFIX.length)}`;
  const known = MODELS.find((m) => m.id === id);
  if (known) return known.label;
  const slash = id.indexOf("/");
  return slash === -1 ? id : id.slice(slash + 1);
}

/**
 * What to call the model a specialist is actually running on right now.
 *
 * `openrouter/auto` names a policy, not a model - it says nothing about what
 * the last turn ran on or cost. Once a turn has actually been answered, that
 * is the more honest thing to show, with the policy kept alongside as a tag
 * rather than dropped. A router that changed its mind mid-turn can have
 * answered under more than one model; the first is shown, in the order it was
 * first seen, which is the same ordering `turnAnsweredBy` already keeps.
 *
 * Devin gets the same treatment for a different reason: `devin:adaptive`
 * names a family, not the effort variant it actually runs a turn on, and
 * bare `devin` names no model at all, only "whatever the account default
 * is". Once a turn has actually answered, `DevinSession` reports what it
 * resolved to (read off the ACP session's own `configOptions`), and that is
 * the more honest thing to show - not tagged `<auto>`, because picking
 * `devin:adaptive` was a real choice, unlike an OpenRouter auto router.
 */
export function runningModelLabel(model: string, answeredBy: readonly string[] | null | undefined): string {
  if (isDevinModel(model)) {
    return answeredBy && answeredBy.length > 0 ? modelLabel(answeredBy[0]) : modelLabel(model);
  }
  if (!isAutoRouter(model) || !answeredBy || answeredBy.length === 0) return modelLabel(model);
  return `${modelLabel(answeredBy[0])} <auto>`;
}
