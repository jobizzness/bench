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
