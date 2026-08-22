import { z } from "zod";

export type SessionStatus =
  | "provisioning"
  | "provisioning_failed"
  | "working"
  | "awaiting_decision"
  | "crashed"
  | "done";

export interface RosterRow {
  id: string;
  label: string;
  project: string;
  status: SessionStatus;
  detail: string;
  latestReportSeq: number | null;
  /** The report the developer has already answered. A decision is only
   * waiting when the latest report is newer than this. */
  answeredReportSeq: number | null;
  /** When the running turn began, so elapsed can tick client-side. */
  startedAt: string | null;
  /** Rough token estimate for the running turn, from the CLI's own counter. */
  tokens: number;
  /** The last few things the specialist actually did, oldest first. Derived
   * from tool calls, so unlike a plan it cannot drift from the truth. */
  activity: Array<{ at: string; text: string }>;
}

export const decisionOptionSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  hint: z.string().optional(),
});

/**
 * An intake option carries the agent's own pick. Exactly the questions it
 * cannot guess are left without a default, and those are the only ones that
 * block sending - so "I need to ask you something" stops being all-or-nothing.
 */
export const intakeOptionSchema = decisionOptionSchema.extend({
  default: z.boolean().optional(),
});

export const intakeQuestionSchema = z.object({
  id: z.string().min(1),
  ask: z.string().min(1),
  /** What swings on the answer. Shown under the question, not in a tooltip. */
  why: z.string().optional(),
  /** Low-stakes questions collapse into one line so the shape stays readable. */
  stakes: z.enum(["high", "low"]).default("high"),
  select: z.enum(["one", "many"]).default("one"),
  options: z.array(intakeOptionSchema).min(1),
  allowFreeText: z.boolean().default(true),
});

export const decisionSchema = z
  .object({
    kind: z.enum(["spec_approval", "question", "completion", "intake"]),
    title: z.string().min(1),
    summary: z.string().min(1),
    options: z.array(decisionOptionSchema).default([]),
    /** Only on an intake: every open question at once, not one at a time. */
    questions: z.array(intakeQuestionSchema).default([]),
    /**
     * One sentence describing what the agent will build, with `{questionId}`
     * holes the cockpit fills live from the current answers. It is how the
     * developer reads a consequence rather than a label.
     */
    brief: z.string().optional(),
    allowFreeText: z.boolean().default(true),
  })
  // An intake with nothing to answer is a malformed intake, not an empty one.
  .refine((d) => d.kind !== "intake" || d.questions.length > 0, {
    message: "an intake decision must carry at least one question",
    path: ["questions"],
  });

export type DecisionOption = z.infer<typeof decisionOptionSchema>;
export type IntakeOption = z.infer<typeof intakeOptionSchema>;
export type IntakeQuestion = z.infer<typeof intakeQuestionSchema>;
export type Decision = z.infer<typeof decisionSchema>;

/** One question's answer on its way back to the agent. */
export interface IntakeAnswer {
  questionId: string;
  ask: string;
  labels: string[];
  text?: string;
  /** True when the developer never touched it and the agent's pick stands. */
  defaulted: boolean;
}

export type ThreadEntryKind = "user" | "reply" | "report";

export interface ThreadEntryInput {
  kind: ThreadEntryKind;
  body: string;
  /** Set on report entries: the turn whose report.html this refers to. */
  reportSeq?: number;
  /** Set on reply entries the specialist answered with a rendered page. */
  replySeq?: number;
}

export interface ThreadEntry extends ThreadEntryInput {
  seq: number;
  at: string;
}
