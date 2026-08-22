import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findReport, latestReportSeq } from "../src/daemon/reports.js";

async function makeReportsDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "bench-rep-"));
}

async function writeReport(dir: string, seq: number, decision: unknown | null) {
  const target = join(dir, String(seq));
  await mkdir(target, { recursive: true });
  await writeFile(join(target, "report.html"), `<h1>report ${seq}</h1>`);
  if (decision !== null) {
    await writeFile(
      join(target, "decision.json"),
      typeof decision === "string" ? decision : JSON.stringify(decision),
    );
  }
}

const goodDecision = {
  kind: "completion",
  title: "Password reset",
  summary: "Done, one call needed.",
  options: [{ id: "ship", label: "Ship it" }],
  allowFreeText: true,
};

describe("findReport", () => {
  it("returns the report with its parsed decision", async () => {
    const dir = await makeReportsDir();
    await writeReport(dir, 1, goodDecision);

    const report = await findReport(dir, 1);
    expect(report?.decision.title).toBe("Password reset");
    expect(report?.malformed).toBe(false);
    expect(report?.htmlPath).toBe(join(dir, "1", "report.html"));
  });

  it("returns null when there is no report for that sequence", async () => {
    const dir = await makeReportsDir();
    expect(await findReport(dir, 7)).toBeNull();
  });

  it("degrades to a free-text decision when decision.json is missing", async () => {
    const dir = await makeReportsDir();
    await writeReport(dir, 1, null);

    const report = await findReport(dir, 1);
    expect(report?.malformed).toBe(true);
    expect(report?.decision.allowFreeText).toBe(true);
    expect(report?.decision.options).toEqual([]);
  });

  it("degrades when decision.json is unparseable", async () => {
    const dir = await makeReportsDir();
    await writeReport(dir, 1, "{ this is not json");

    const report = await findReport(dir, 1);
    expect(report?.malformed).toBe(true);
    expect(report?.decision.allowFreeText).toBe(true);
  });

  it("degrades when decision.json parses but fails the schema", async () => {
    const dir = await makeReportsDir();
    await writeReport(dir, 1, { kind: "nonsense", title: "" });

    const report = await findReport(dir, 1);
    expect(report?.malformed).toBe(true);
  });

  it("ignores a directory with decision.json but no report.html", async () => {
    const dir = await makeReportsDir();
    const target = join(dir, "1");
    await mkdir(target, { recursive: true });
    await writeFile(join(target, "decision.json"), JSON.stringify(goodDecision));

    expect(await findReport(dir, 1)).toBeNull();
  });
});

const intakeDecision = {
  kind: "intake",
  title: "Password reset — before I build",
  summary: "Three questions, two answered.",
  brief: "Links expire after {expiry} and cover {flows}.",
  questions: [
    {
      id: "expiry",
      ask: "How long should a reset token live?",
      why: "Sets the email copy.",
      options: [
        { id: "15m", label: "15 minutes" },
        { id: "1h", label: "1 hour", default: true },
      ],
    },
    {
      id: "flows",
      ask: "Which entry points?",
      stakes: "low",
      select: "many",
      options: [{ id: "web", label: "Web", default: true }],
    },
  ],
};

describe("intake decisions", () => {
  it("parses questions, defaults and the brief", async () => {
    const dir = await makeReportsDir();
    await writeReport(dir, 1, intakeDecision);

    const report = await findReport(dir, 1);
    expect(report?.malformed).toBe(false);
    expect(report?.decision.kind).toBe("intake");
    expect(report?.decision.brief).toBe("Links expire after {expiry} and cover {flows}.");
    expect(report?.decision.questions).toHaveLength(2);
    expect(report?.decision.questions[0].options[1].default).toBe(true);
    expect(report?.decision.questions[1].select).toBe("many");
  });

  it("fills in the defaults a specialist left out", async () => {
    const dir = await makeReportsDir();
    await writeReport(dir, 1, intakeDecision);

    const [first, second] = (await findReport(dir, 1))!.decision.questions;
    // Omitted stakes must read as "show it", never as "fold it away".
    expect(first.stakes).toBe("high");
    expect(first.select).toBe("one");
    expect(first.allowFreeText).toBe(true);
    expect(second.stakes).toBe("low");
  });

  it("degrades an intake that carries no questions", async () => {
    const dir = await makeReportsDir();
    await writeReport(dir, 1, { ...intakeDecision, questions: [] });

    const report = await findReport(dir, 1);
    expect(report?.malformed).toBe(true);
    expect(report?.decision.allowFreeText).toBe(true);
  });

  it("degrades a question with no options to choose from", async () => {
    const dir = await makeReportsDir();
    await writeReport(dir, 1, {
      ...intakeDecision,
      questions: [{ id: "q", ask: "Well?", options: [] }],
    });

    expect((await findReport(dir, 1))?.malformed).toBe(true);
  });

  it("leaves an ordinary decision with an empty question list", async () => {
    const dir = await makeReportsDir();
    await writeReport(dir, 1, goodDecision);

    const report = await findReport(dir, 1);
    expect(report?.malformed).toBe(false);
    expect(report?.decision.questions).toEqual([]);
  });
});

describe("latestReportSeq", () => {
  it("returns the highest sequence present", async () => {
    const dir = await makeReportsDir();
    await writeReport(dir, 1, goodDecision);
    await writeReport(dir, 2, goodDecision);
    expect(await latestReportSeq(dir)).toBe(2);
  });

  it("sorts numerically, not lexically", async () => {
    const dir = await makeReportsDir();
    await writeReport(dir, 2, goodDecision);
    await writeReport(dir, 10, goodDecision);
    expect(await latestReportSeq(dir)).toBe(10);
  });

  it("returns null when no reports exist", async () => {
    const dir = await makeReportsDir();
    expect(await latestReportSeq(dir)).toBeNull();
  });
});
