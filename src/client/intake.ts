import type { Decision, IntakeAnswer, IntakeQuestion } from "../shared/types.js";

/**
 * The intake's rules, with no DOM in them.
 *
 * Asking one question, waiting, then asking the next never shows the shape of
 * what is unclear, and makes every question block equally. An intake inverts
 * that: the specialist answers its own questions first, shows all of them at
 * once, and only the ones it genuinely could not guess stand between the
 * developer and "go".
 */

export interface Answer {
  /** Chosen option ids. An array, not a Set, so state updates stay cheap. */
  ids: string[];
  text: string;
  /** The developer has been here. An untouched answer is still the agent's. */
  touched: boolean;
}

export type Answers = Readonly<Record<string, Answer>>;

export type QuestionState = "open" | "changed" | "assumed";

export const STATE_CHIP: Record<QuestionState, string> = {
  open: "needs you",
  changed: "your call",
  assumed: "assumed",
};

const EMPTY: Answer = { ids: [], text: "", touched: false };

/**
 * Seeded from the specialist's own picks, so an untouched intake is already a
 * complete set of answers rather than an empty form.
 */
export function seedAnswers(decision: Decision | null): Answers {
  const seeded: Record<string, Answer> = {};
  for (const question of decision?.questions ?? []) {
    seeded[question.id] = {
      ids: question.options.filter((o) => o.default).map((o) => o.id),
      text: "",
      touched: false,
    };
  }
  return seeded;
}

export const answerFor = (answers: Answers, question: IntakeQuestion): Answer =>
  answers[question.id] ?? EMPTY;

export const labelsFor = (answers: Answers, question: IntakeQuestion): string[] =>
  question.options.filter((o) => answerFor(answers, question).ids.includes(o.id)).map((o) => o.label);

/** Free text alone counts: a question can be answered off the menu. */
export function isAnswered(answers: Answers, question: IntakeQuestion): boolean {
  const answer = answerFor(answers, question);
  return answer.ids.length > 0 || answer.text.trim() !== "";
}

export function questionState(answers: Answers, question: IntakeQuestion): QuestionState {
  if (answerFor(answers, question).touched) return "changed";
  return isAnswered(answers, question) ? "assumed" : "open";
}

/** What the answer reads as in prose - a chosen label, or the developer's own words. */
export const spokenAnswer = (answers: Answers, question: IntakeQuestion): string =>
  labelsFor(answers, question).join(" and ") || answerFor(answers, question).text.trim();

const guessed = (question: IntakeQuestion) => question.options.some((o) => o.default);

/**
 * Split on what the specialist could guess, not on what the developer has done
 * since - so a question never jumps between the two lists mid-read.
 */
export function splitQuestions(decision: Decision | null): {
  open: IntakeQuestion[];
  assumed: IntakeQuestion[];
} {
  const open: IntakeQuestion[] = [];
  const assumed: IntakeQuestion[] = [];

  for (const question of decision?.questions ?? []) {
    (question.stakes === "low" && guessed(question) ? assumed : open).push(question);
  }

  // A question the specialist could not guess is the only kind that blocks
  // sending, so it leads - the panel scrolls, and the first screen must not
  // hide the one thing standing in the way. The sort is on what the specialist
  // did, not on what you have answered since, so the order holds still while
  // you work down it.
  open.sort((a, b) => Number(guessed(a)) - Number(guessed(b)));
  return { open, assumed };
}

export function pickOption(answers: Answers, question: IntakeQuestion, optionId: string): Answers {
  const current = answerFor(answers, question);
  const ids = question.select === "many"
    ? (current.ids.includes(optionId)
      ? current.ids.filter((id) => id !== optionId)
      : [...current.ids, optionId])
    : [optionId];

  return { ...answers, [question.id]: { ...current, ids, touched: true } };
}

export function writeText(answers: Answers, question: IntakeQuestion, text: string): Answers {
  const current = answerFor(answers, question);
  return {
    ...answers,
    // Clearing the box does not un-choose an option, so touched survives it.
    [question.id]: { ...current, text, touched: text.trim() !== "" || current.ids.length > 0 },
  };
}

/** In the order the specialist asked them, whatever order they were shown in. */
export function intakePayload(decision: Decision, answers: Answers): IntakeAnswer[] {
  return decision.questions.map((question) => ({
    questionId: question.id,
    ask: question.ask,
    labels: labelsFor(answers, question),
    text: answerFor(answers, question).text.trim(),
    defaulted: !answerFor(answers, question).touched,
  }));
}

export interface SendBar {
  label: string;
  blocked: boolean;
  pending: number;
}

/**
 * The button says what pressing it will do, in the developer's terms. With
 * nothing overridden it reads as one keypress; with something unanswerable
 * outstanding it refuses and says how many.
 */
export function sendBar(decision: Decision, answers: Answers): SendBar {
  const pending = decision.questions.filter((q) => !isAnswered(answers, q)).length;
  const changed = decision.questions.filter((q) => answerFor(answers, q).touched).length;
  const total = decision.questions.length;

  const label = pending > 0
    ? `${pending} still ${pending === 1 ? "needs" : "need"} you`
    : changed > 0
      ? `Send ${total} answers · ${changed} yours`
      : `Go with all ${total} assumptions`;

  return { label, blocked: pending > 0, pending };
}

export type BriefSegment =
  | { kind: "text"; text: string }
  | { kind: "slot"; text: string; state: QuestionState; ask: string }
  /** A hole naming no question: the specialist's mistake, shown rather than hidden. */
  | { kind: "missing"; text: string };

const HOLE = /\{([A-Za-z0-9_-]+)\}/g;

/**
 * The specialist writes one sentence with `{questionId}` holes in it. Filling
 * them live is the part no one-question-at-a-time flow can do: it needs every
 * answer at once, and it is what turns picking a label into reading a
 * consequence.
 */
export function briefSegments(decision: Decision, answers: Answers): BriefSegment[] {
  const brief = decision.brief;
  if (!brief) return [];

  const byId = new Map(decision.questions.map((q) => [q.id, q]));
  const segments: BriefSegment[] = [];
  let last = 0;

  for (const match of brief.matchAll(HOLE)) {
    const at = match.index;
    if (at > last) segments.push({ kind: "text", text: brief.slice(last, at) });

    const question = byId.get(match[1]);
    if (!question) segments.push({ kind: "missing", text: match[0] });
    else {
      segments.push({
        kind: "slot",
        text: spokenAnswer(answers, question),
        state: questionState(answers, question),
        ask: question.ask,
      });
    }
    last = at + match[0].length;
  }

  if (last < brief.length) segments.push({ kind: "text", text: brief.slice(last) });
  return segments;
}
