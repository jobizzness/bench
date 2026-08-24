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
}).transform((s) => ({ ...s, reviewModel: s.reviewModel ?? DEFAULT_MODEL }));

export type Settings = z.infer<typeof settingsSchema>;

export const NO_SETTINGS: Settings = { codingStyle: "", workflowRules: "", reviewModel: DEFAULT_MODEL };

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
