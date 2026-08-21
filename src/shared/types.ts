import { z } from "zod";

export type TurnKind = "work" | "chat";

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
}

export const decisionOptionSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  hint: z.string().optional(),
});

export const decisionSchema = z.object({
  kind: z.enum(["spec_approval", "question", "completion"]),
  title: z.string().min(1),
  summary: z.string().min(1),
  options: z.array(decisionOptionSchema).default([]),
  allowFreeText: z.boolean().default(true),
});

export type DecisionOption = z.infer<typeof decisionOptionSchema>;
export type Decision = z.infer<typeof decisionSchema>;

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
