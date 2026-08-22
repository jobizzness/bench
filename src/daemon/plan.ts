import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

export const planStepSchema = z.object({
  text: z.string().min(1),
  state: z.enum(["todo", "doing", "done"]).default("todo"),
});

export const planSchema = z.object({
  steps: z.array(planStepSchema).max(50),
});

export type PlanStep = z.infer<typeof planStepSchema>;

/**
 * A specialist's own checklist. The CLI gives it no todo tool, so the turn
 * framing asks it to keep this file current - the same mechanism that gets
 * reports written.
 *
 * Unlike the activity trail this is self-reported and can go stale, which is
 * exactly why both exist: one says what it means to do, the other what it
 * actually did.
 */
export async function readPlan(reportsDir: string): Promise<PlanStep[] | null> {
  const turn = await currentTurn(reportsDir);
  if (turn !== null) {
    const steps = await readPlanFile(join(reportsDir, String(turn), "plan.json"));
    if (steps) return steps;
  }

  // The marker may name a turn that never wrote one. The most recent plan on
  // disk still describes where the specialist got to.
  for (const seq of await turnsDescending(reportsDir)) {
    const steps = await readPlanFile(join(reportsDir, String(seq), "plan.json"));
    if (steps) return steps;
  }
  return null;
}

async function readPlanFile(path: string): Promise<PlanStep[] | null> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return null;
  }

  // A malformed plan must never break the cockpit: no plan reads better than
  // a broken one.
  try {
    return planSchema.parse(JSON.parse(raw)).steps;
  } catch {
    return null;
  }
}

async function currentTurn(reportsDir: string): Promise<number | null> {
  try {
    const value = Number((await readFile(join(reportsDir, ".turn"), "utf8")).trim());
    return Number.isInteger(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}

async function turnsDescending(reportsDir: string): Promise<number[]> {
  try {
    const names = await readdir(reportsDir);
    return names
      .filter((name) => /^\d+$/.test(name))
      .map(Number)
      .sort((a, b) => b - a);
  } catch {
    return [];
  }
}
