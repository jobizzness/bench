import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readPlan } from "../src/daemon/plan.js";

async function makeReports() {
  return mkdtemp(join(tmpdir(), "bench-plan-"));
}

async function writePlan(dir: string, turn: number, body: unknown) {
  await mkdir(join(dir, String(turn)), { recursive: true });
  await writeFile(join(dir, String(turn), "plan.json"),
    typeof body === "string" ? body : JSON.stringify(body));
}

describe("readPlan", () => {
  it("returns nothing when the specialist has not written one", async () => {
    expect(await readPlan(await makeReports())).toBeNull();
  });

  it("reads the current turn's plan", async () => {
    const dir = await makeReports();
    await writeFile(join(dir, ".turn"), "2");
    await writePlan(dir, 2, { steps: [
      { text: "Read the failing test", state: "done" },
      { text: "Fix the guard", state: "doing" },
      { text: "Run the suite", state: "todo" },
    ] });

    const steps = (await readPlan(dir))!;
    expect(steps).toHaveLength(3);
    expect(steps[1]).toEqual({ text: "Fix the guard", state: "doing" });
  });

  it("defaults a step with no state to todo", async () => {
    const dir = await makeReports();
    await writeFile(join(dir, ".turn"), "1");
    await writePlan(dir, 1, { steps: [{ text: "Something" }] });

    expect((await readPlan(dir))![0].state).toBe("todo");
  });

  it("falls back to the most recent plan when this turn wrote none", async () => {
    const dir = await makeReports();
    await writePlan(dir, 1, { steps: [{ text: "From turn one", state: "done" }] });
    await mkdir(join(dir, "2"), { recursive: true });
    await writeFile(join(dir, ".turn"), "2");

    expect((await readPlan(dir))![0].text).toBe("From turn one");
  });

  it("treats a malformed plan as no plan, rather than breaking the cockpit", async () => {
    const dir = await makeReports();
    await writeFile(join(dir, ".turn"), "1");
    await writePlan(dir, 1, "{ not json");

    expect(await readPlan(dir)).toBeNull();
  });

  it("rejects a plan of the wrong shape", async () => {
    const dir = await makeReports();
    await writeFile(join(dir, ".turn"), "1");
    await writePlan(dir, 1, { steps: [{ text: "ok", state: "banana" }] });

    expect(await readPlan(dir)).toBeNull();
  });

  it("refuses an absurdly long plan", async () => {
    const dir = await makeReports();
    await writeFile(join(dir, ".turn"), "1");
    await writePlan(dir, 1, { steps: Array.from({ length: 51 }, (_, i) => ({ text: `s${i}` })) });

    expect(await readPlan(dir)).toBeNull();
  });
});
