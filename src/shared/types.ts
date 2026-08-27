import { z } from "zod";
import type { Context } from "./context-window.js";
import type { Role } from "./roles.js";

export type SessionStatus =
  | "provisioning"
  | "provisioning_failed"
  | "working"
  | "awaiting_decision"
  /** Another specialist told it to do something, and the message is held
   * for the developer to read before it runs. */
  | "awaiting_dispatch"
  | "crashed"
  | "done";

export interface RosterRow {
  id: string;
  label: string;
  /** What kind of agent this is. A name on the roster, nothing more. */
  role: Role;
  /** The branch it is on. Empty until a worktree has been provisioned. */
  branch: string;
  /** False when it works in the project checkout itself, alongside the
   * developer - which is the case worth seeing before you wonder who else
   * has been editing your files. */
  isolated: boolean;
  project: string;
  /**
   * The alias it was created on. Fixed for the life of the specialist - the
   * CLI is holding a conversation started on that model - so it is a fact
   * about the specialist rather than a setting, and worth seeing beside its
   * name when half your bench is deliberately cheap.
   */
  model: string;
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
  /** How full the conversation is, as of its last finished turn. Null until
   * it has taken one. */
  context: Context | null;
  /** The last few things the specialist actually did, oldest first. Derived
   * from tool calls, so unlike a plan it cannot drift from the truth. */
  activity: Array<{ at: string; text: string }>;
  /** What it has cost since it was made. Null until it has finished a turn,
   * and on every specialist that ran before this was recorded. */
  spend: Spend | null;
  /** Which models actually answered the last finished turn, where `model` is
   * a router rather than a model in its own right. Null until a turn has
   * finished, and always null on a model that answers for itself. */
  answeredBy: string[] | null;
  /** The specialist that opened this tab with `bench new`, if one did.
   * Null for a tab the developer opened themselves. Persisted, so a daemon
   * restart keeps the nesting the roster draws from it. */
  createdBy: string | null;
  /** The message an agent told this tab, held back until the developer
   * dispatches it. Null once dispatched, declined, or never held. */
  pendingPrompt: string | null;
  /** Model reasoning/thinking effort level. */
  reasoningEffort?: "none" | "low" | "medium" | "high";
}

/**
 * What a specialist has run up.
 *
 * Two kinds of money and they must not be added together. A turn that went
 * straight to Anthropic on the machine's login is paid for by a subscription
 * already bought - the figure is what that turn would have cost at list
 * price, which is worth knowing and is not a bill. A turn answered by
 * OpenRouter is money out of the developer's account today.
 */
export interface Spend {
  /** Dollars, at list price for a plan turn and actual for an account one. */
  dollars: number;
  /** How many finished turns are in that figure. */
  turns: number;
  /** Who paid: the subscription, or the OpenRouter balance. */
  billed: "plan" | "account";
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

export type ThreadEntryKind = "user" | "reply" | "report" | "system";

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
