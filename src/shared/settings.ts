import { z } from "zod";
import { DEFAULT_MODEL, isModelId } from "./models.js";

/**
 * How the developer wants work done, said once instead of retyped into every
 * prompt. Two fields, both free text: these are instructions to a model, and
 * a form of checkboxes would pretend to a precision they do not have.
 *
 * They live in ~/.bench, not in the project - a project's own conventions
 * belong in its CLAUDE.md, which specialists already read.
 */
export const settingsSchema = z.object({
  codingStyle: z.string().max(4000).default(""),
  workflowRules: z.string().max(4000).default(""),
  /**
   * The model a review session is opened on. Not the model specialists run
   * on: that is chosen per specialist, when it is made, and reviewing is the
   * one job Bench starts on your behalf - so it is the one that needs a
   * standing answer.
   */
  reviewModel: z.string().default(DEFAULT_MODEL),
  /**
   * The developer's own answer to "what does this kind of work run on",
   * overriding the built-in table in role-models.ts.
   *
   * Only what has been changed is kept. A copy of all five written into the
   * file is a copy that stops following the built-in table the first time a
   * model is renamed or a role is added - and every bench that ever opened
   * Settings would have one.
   */
  roleModels: z.record(z.string(), z.string()).default({}),
  /**
   * Model reasoning/thinking effort level for reasoning models.
   * Maps to Google's thinking_level or OpenAI's reasoning_effort.
   */
  reasoningEffort: z.enum(["none", "low", "medium", "high"]).default("medium"),
  /**
   * Route Anthropic-direct specialists through a local Headroom proxy, which
   * compresses what each turn sends. On by default because it only takes
   * effect when the binary is installed - a bench without headroom is
   * unchanged either way. Applies to the next spawn; a running specialist's
   * environment is already fixed.
   */
  headroom: z.boolean().default(true),
  /**
   * The one Anthropic credential the developer has told this bench to
   * spend, by its id in the profile's list. `null` is "no opinion" - the
   * daemon's ordinary rule (in use, then most headroom, then whatever could
   * not be checked) decides instead. A strong preference, not a lock: a
   * turn is never held for a pinned key that has run out, but the pin
   * outranks the key already in use once the pinned one is usable again -
   * see `pickManagedKey` in `registry.ts`.
   */
  pinnedManagedKeyId: z.string().nullable().default(null),
});

/**
 * Lenient reading a file, strict accepting a save. A file written before a
 * field existed should still load; a request that simply omits a field would
 * otherwise erase rules the developer never touched - and an unparseable body
 * arrives here as `{}`.
 */
export const settingsInputSchema = z.object({
  codingStyle: z.string().max(4000),
  workflowRules: z.string().max(4000),
  // Absent means the client predates the field, which is not a reason to
  // refuse the rules it did send.
  reviewModel: z.string().refine(isModelId, "not a model this bench offers").optional(),
  roleModels: z.record(z.string(), z.string().refine(isModelId, "not a model this bench offers")).optional(),
  reasoningEffort: z.enum(["none", "low", "medium", "high"]).optional(),
  headroom: z.boolean().optional(),
  pinnedManagedKeyId: z.string().nullable().optional(),
}).transform((s) => ({
  ...s,
  reviewModel: s.reviewModel ?? DEFAULT_MODEL,
  roleModels: s.roleModels ?? {},
  reasoningEffort: s.reasoningEffort ?? "medium",
  headroom: s.headroom ?? true,
  pinnedManagedKeyId: s.pinnedManagedKeyId ?? null,
}));

export type Settings = z.infer<typeof settingsSchema>;

export const NO_SETTINGS: Settings = {
  codingStyle: "", workflowRules: "", reviewModel: DEFAULT_MODEL, roleModels: {}, reasoningEffort: "medium", headroom: true,
  pinnedManagedKeyId: null,
};

/**
 * What a specialist is actually told, assembled.
 *
 * Shared rather than daemon-side because the page shows it back as you type:
 * a rule you cannot read in the words the agent receives is a rule you cannot
 * debug, and a preview composed separately would drift from the real thing
 * the first time either changed.
 *
 * Empty in, empty out - a specialist with no house rules is told nothing at
 * all rather than told there are none.
 */
export function houseRules(settings: Settings): string {
  const style = settings.codingStyle.trim();
  const workflow = settings.workflowRules.trim();
  if (style === "" && workflow === "") return "";

  const parts = [
    "[bench] House rules. How this developer wants work done - standing " +
    "instructions that hold for every turn, not the task itself.",
  ];
  if (style !== "") parts.push(`Coding style:\n${style}`);
  if (workflow !== "") parts.push(`Workflow:\n${workflow}`);
  return parts.join("\n\n");
}
