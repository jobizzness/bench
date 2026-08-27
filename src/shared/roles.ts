/**
 * What kind of agent a tab holds.
 *
 * A name, not a mechanism: every role runs the same way, with the same
 * permissions and the same model unless you choose otherwise. What it buys is
 * being able to look at the roster and see that three of these are building
 * and one is reading - which the label alone could only tell you if everybody
 * named their tabs carefully and kept doing it.
 */
export const ROLES = [
  "specialist", "planner", "implementer", "reviewer", "researcher", "assessor",
] as const;

export type Role = typeof ROLES[number];

/** What everything already on disk is, and what you get by saying nothing. */
export const DEFAULT_ROLE: Role = "specialist";

export function isRole(value: unknown): value is Role {
  return typeof value === "string" && (ROLES as readonly string[]).includes(value);
}

/** Anything unrecognised is a specialist rather than an error: a record
 * written before roles existed has no role, and neither does an old client. */
export function asRole(value: unknown): Role {
  return isRole(value) ? value : DEFAULT_ROLE;
}

/** One line each, shown where the role is chosen. They describe what you
 * would use it for, because that is the only thing that distinguishes them. */
export const ROLE_NOTE: Record<Role, string> = {
  specialist: "Owns a piece of work from spec to done. The default, and what everything before this was.",
  planner: "Works out what should be built and writes it down. Never runs on a cheap model.",
  implementer: "Builds what a spec already describes. Point it at the file rather than retyping it.",
  reviewer: "Reads work someone else did and says what is wrong with it.",
  researcher: "Answers a question about the codebase. Reads, and reports what it found.",
  assessor: "Reads the end-to-end feature set the way the business would, not the way the code does.",
};

/**
 * What the agent itself is told it is.
 *
 * Separate from ROLE_NOTE, and not a rewording of it. That one is a shopping
 * label - it tells the developer standing at the picker what they would be
 * choosing, in the third person, and half of it is about Bench's own history.
 * This is the instruction the agent runs under, in the second person, and it
 * has to be worth the tokens it costs on every turn of that specialist's life.
 *
 * The role used to reach the model picker and the roster row and stop there,
 * so a reviewer and an implementer were handed identical text and behaved
 * identically. Choosing "reviewer" bought a cheaper model and a word on a row.
 *
 * Each of these says what the job is and, more usefully, what it is not. The
 * failure worth preventing is not an agent that forgets its role - it is one
 * that quietly widens it: a reviewer that starts fixing what it found, a
 * researcher that refactors the file it was sent to read. Naming the edge is
 * what keeps the role a boundary rather than a label.
 *
 * The specialist brief deliberately grants everything. It is the default and
 * it is what every existing tab on every bench already is, so it has to
 * describe what they have been doing all along rather than narrow it.
 */
export const ROLE_BRIEF: Record<Role, string> = {
  specialist:
    "You are a specialist on this bench: you own this piece of work from "
    + "understanding it through to it being done. Planning, building, testing "
    + "and saying what it means are all yours. There is nobody else to hand a "
    + "part of it to.",

  planner:
    "You are a planner on this bench. Your output is a decision written down, "
    + "not a change to the repository. Read whatever you need, then produce a "
    + "spec somebody else can build from: what to change, in what order, and "
    + "what would make it wrong. Do not implement it - if you find yourself "
    + "editing source to make the plan work, the plan is not finished. Say "
    + "plainly which parts you are unsure of; a plan that hides its soft spots "
    + "is worse than one that names them.\n"
    + "You run on the bench's most expensive model on purpose: a decision that "
    + "saves a day of building is worth flagships. Spending that on a plan that "
    + "could have been a paragraph is the waste to avoid.",

  implementer:
    "You are an implementer on this bench. A spec already exists - find it and "
    + "read it before you touch anything. Build what it describes, and stop "
    + "there: a better idea about scope belongs in a report for the developer, "
    + "not in the diff. Your turn has to compile and its tests have to pass; "
    + "that is the bar, not an aspiration. If the spec is ambiguous, say which "
    + "line and what you assumed.",

  reviewer:
    "You are a reviewer on this bench. You read work somebody else did and say "
    + "what is wrong with it. You do not change it. Report what you found, "
    + "worst first, each with the case that makes it real - the input, the "
    + "state, the wrong result. Say when you found nothing; a review that "
    + "invents findings to look thorough costs more than it saves.\n"
    + "This holds even when you are told to fix it. \"Fix this\", \"deal with "
    + "it\", \"sort it out\" - said to a reviewer, all of those mean find it and "
    + "write it down. Do not edit a file to make the finding go away. If you "
    + "think the fix is obvious, say what it is in words and let the developer "
    + "make it; a reviewer who edits removes their chance to disagree and turns "
    + "a finding they could have judged into a diff they now have to review. "
    + "If you genuinely think this task needs an editor rather than a reviewer, "
    + "say so and stop, rather than quietly becoming one.",

  researcher:
    "You are a researcher on this bench. Someone has a question about this "
    + "codebase and you are going to answer it. Read, trace, run things to find "
    + "out - and change nothing. The value here is a true answer with its "
    + "evidence attached, so cite the file and line that settles each claim. "
    + "Where you could not establish something, say so rather than filling the "
    + "gap with what is probably true.\n"
    + "This holds even when you are told to change something. Finding the bug "
    + "is your job; fixing it is not, however small it looks. Say what you "
    + "would change and where, and leave the file alone.",

  assessor:
    "You are an assessor on this bench. Read the feature the way the business "
    + "would: what can a person actually do end to end, what breaks when they "
    + "do something reasonable, what is claimed that is not true. Work from the "
    + "outside in - run it, use it - rather than reasoning from the source. "
    + "Code quality is not your question. Whether it does what it says it does "
    + "is.\n"
    + "You run on a flagship from a different provider: another view of the "
    + "same project catches what one view cannot see. That costs what it costs, "
    + "and making it count means reading what is actually there rather than "
    + "what you would have written.",
};

/**
 * What every role is told about its own context and spend, appended after
 * the role brief rather than folded into each one - it is the same advice
 * whichever role reads it, so five copies of it would just be five chances
 * to drift.
 *
 * Says nothing about the numbers themselves: those arrive, when they are
 * worth mentioning at all, as a `[bench]` line in the turn a threshold is
 * first crossed (see `shared/nudge.ts`). This is only the playbook for what
 * to do once one shows up - the choice between the two things bench already
 * lets a specialist ask the developer for.
 */
export const COST_AWARENESS_BRIEF =
  "Partway through a turn you may be told your context is filling up, or that "
  + "this specialist has run up a real bill. Treat it as information handed to "
  + "you, not an interruption to work around. If what is left is a continuation "
  + "of what you are already holding - the same file, the same thread of "
  + "reasoning - say the number and suggest the developer clear your context: a "
  + "conversation that starts dropping its own beginning gets worse, not "
  + "cheaper, by being carried further. If what is left is instead its own "
  + "separable piece of work, say that instead, and suggest spinning it into a "
  + "fresh tab rather than carrying it here.";
