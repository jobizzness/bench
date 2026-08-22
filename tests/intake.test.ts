import { describe, it, expect } from "vitest";
import { decisionSchema } from "../src/shared/types.js";
import {
  briefSegments, intakePayload, isAnswered, pickOption, questionState, seedAnswers,
  sendBar, splitQuestions, writeText,
} from "../src/client/intake.js";

/** The intake's rules, with no DOM in the way. */

const INTAKE = decisionSchema.parse({
  kind: "intake",
  title: "Password reset",
  summary: "Four questions.",
  brief: "Links expire after {expiry}, cover {flows}, and resets {audit} the audit trail.",
  questions: [
    {
      id: "expiry", ask: "How long should a reset token live?",
      options: [{ id: "15m", label: "15 minutes" }, { id: "1h", label: "1 hour", default: true }],
    },
    {
      id: "flows", ask: "Which entry points get it?", select: "many",
      options: [{ id: "web", label: "Web", default: true }, { id: "mobile", label: "Mobile" }],
    },
    {
      // No default anywhere: the specialist genuinely cannot guess this one.
      id: "audit", ask: "Log resets to the audit trail?",
      options: [{ id: "yes", label: "go to" }, { id: "no", label: "stay out of" }],
    },
    {
      id: "ratelimit", ask: "Rate limit the endpoint?", stakes: "low",
      options: [{ id: "reuse", label: "the existing limiter", default: true }],
    },
  ],
});

const q = (id: string) => INTAKE.questions.find((x) => x.id === id)!;
const seeded = () => seedAnswers(INTAKE);
const asks = (questions: Array<{ ask: string }>) => questions.map((x) => x.ask);

describe("seeding", () => {
  it("pre-selects the specialist's own picks", () => {
    const answers = seeded();
    expect(answers.expiry.ids).toEqual(["1h"]);
    expect(answers.flows.ids).toEqual(["web"]);
    // The one it could not guess starts empty, and that is the whole point.
    expect(answers.audit.ids).toEqual([]);
  });

  it("marks nothing as touched, so an untouched intake is still the agent's", () => {
    expect(Object.values(seeded()).every((a) => !a.touched)).toBe(true);
  });

  it("counts a seeded question as answered and an unguessed one as not", () => {
    expect(isAnswered(seeded(), q("expiry"))).toBe(true);
    expect(isAnswered(seeded(), q("audit"))).toBe(false);
  });
});

describe("splitting", () => {
  it("folds away only what is low-stakes and already guessed", () => {
    const { open, assumed } = splitQuestions(INTAKE);
    expect(asks(assumed)).toEqual(["Rate limit the endpoint?"]);
    expect(open).toHaveLength(3);
  });

  it("leads with the question the specialist could not guess", () => {
    // The panel scrolls; what blocks sending must not sit under the fold.
    expect(asks(splitQuestions(INTAKE).open)[0]).toBe("Log resets to the audit trail?");
  });

  it("keeps a low-stakes question open when it was left undefaulted", () => {
    const cannotGuess = decisionSchema.parse({
      ...INTAKE,
      questions: [{
        id: "x", ask: "Well?", stakes: "low",
        options: [{ id: "a", label: "A" }, { id: "b", label: "B" }],
      }],
    });
    expect(splitQuestions(cannotGuess).assumed).toHaveLength(0);
  });
});

describe("answering", () => {
  it("replaces on a single-select question", () => {
    const answers = pickOption(seeded(), q("expiry"), "15m");
    expect(answers.expiry.ids).toEqual(["15m"]);
    expect(answers.expiry.touched).toBe(true);
  });

  it("adds and removes on a multi-select question", () => {
    let answers = pickOption(seeded(), q("flows"), "mobile");
    expect(answers.flows.ids).toEqual(["web", "mobile"]);
    answers = pickOption(answers, q("flows"), "web");
    expect(answers.flows.ids).toEqual(["mobile"]);
  });

  it("treats free text alone as an answer", () => {
    const answers = writeText(seeded(), q("audit"), "only for staff");
    expect(isAnswered(answers, q("audit"))).toBe(true);
    expect(questionState(answers, q("audit"))).toBe("changed");
  });

  it("does not un-choose an option when the box is cleared again", () => {
    const answers = writeText(pickOption(seeded(), q("expiry"), "15m"), q("expiry"), "");
    expect(answers.expiry.touched).toBe(true);
  });

  it("never mutates the answers it was given", () => {
    const before = seeded();
    pickOption(before, q("expiry"), "15m");
    expect(before.expiry.ids).toEqual(["1h"]);
  });
});

describe("the send bar", () => {
  it("refuses while an unguessable question is unanswered, and says how many", () => {
    expect(sendBar(INTAKE, seeded())).toMatchObject({ blocked: true, label: "1 still needs you" });
  });

  it("counts up when more than one is outstanding", () => {
    const two = decisionSchema.parse({
      ...INTAKE,
      questions: INTAKE.questions.filter((x) => x.id === "audit").concat([
        { ...q("audit"), id: "audit2" },
      ]),
    });
    expect(sendBar(two, seedAnswers(two)).label).toBe("2 still need you");
  });

  it("offers one keypress when nothing has been overridden", () => {
    const answers = pickOption(seeded(), q("audit"), "yes");
    // audit is the only one the developer touched, so the rest are still
    // assumptions - but they are answers, and the bar can send.
    expect(sendBar(INTAKE, answers)).toMatchObject({
      blocked: false, label: "Send 4 answers · 1 yours",
    });
  });

  it("says so plainly when every answer is the specialist's own", () => {
    const guessable = decisionSchema.parse({
      ...INTAKE, questions: INTAKE.questions.filter((x) => x.id !== "audit"),
    });
    expect(sendBar(guessable, seedAnswers(guessable)).label).toBe("Go with all 3 assumptions");
  });
});

describe("the payload", () => {
  it("keeps the specialist's own order, not the order they were shown in", () => {
    const answers = pickOption(seeded(), q("audit"), "yes");
    expect(intakePayload(INTAKE, answers).map((a) => a.questionId))
      .toEqual(["expiry", "flows", "audit", "ratelimit"]);
  });

  it("marks which answers the developer never touched", () => {
    const answers = pickOption(seeded(), q("audit"), "yes");
    const payload = intakePayload(INTAKE, answers);
    expect(payload.find((a) => a.questionId === "audit")).toMatchObject({
      labels: ["go to"], defaulted: false,
    });
    // Never opened, never touched - and it says so.
    expect(payload.find((a) => a.questionId === "ratelimit")).toMatchObject({
      labels: ["the existing limiter"], defaulted: true,
    });
  });

  it("carries free text alongside the labels", () => {
    const answers = writeText(seeded(), q("expiry"), "  whatever the OTP does  ");
    expect(intakePayload(INTAKE, answers)[0]).toMatchObject({
      labels: ["1 hour"], text: "whatever the OTP does",
    });
  });
});

describe("the brief", () => {
  it("fills its holes from the current answers", () => {
    expect(briefSegments(INTAKE, seeded()).map((s) => s.text).join(""))
      .toBe("Links expire after 1 hour, cover Web, and resets  the audit trail.");
  });

  it("joins a multi-select with a word, not a comma", () => {
    const answers = pickOption(seeded(), q("flows"), "mobile");
    expect(briefSegments(INTAKE, answers).map((s) => s.text).join(""))
      .toContain("cover Web and Mobile");
  });

  it("marks what the developer changed apart from what was assumed", () => {
    const answers = pickOption(seeded(), q("expiry"), "15m");
    const slots = briefSegments(INTAKE, answers).filter((s) => s.kind === "slot");
    expect(slots.map((s) => (s as { state: string }).state)).toEqual(["changed", "assumed", "open"]);
  });

  it("shows a hole naming no question rather than dropping half the sentence", () => {
    const wrong = decisionSchema.parse({ ...INTAKE, brief: "Expires after {nonsense}." });
    expect(briefSegments(wrong, seeded())).toEqual([
      { kind: "text", text: "Expires after " },
      { kind: "missing", text: "{nonsense}" },
      { kind: "text", text: "." },
    ]);
  });

  it("is empty when the specialist wrote no brief", () => {
    const none = decisionSchema.parse({ ...INTAKE, brief: undefined });
    expect(briefSegments(none, seeded())).toEqual([]);
  });
});
