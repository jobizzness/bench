/**
 * @vitest-environment jsdom
 * @vitest-environment-options { "url": "http://localhost/?token=t" }
 */
import { describe, it, expect, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { decisionSchema } from "../src/shared/types.js";
import { bootCockpit, entry, row, type Cockpit } from "./helpers/cockpit.js";

/**
 * Where a specialist has got to, in the main pane.
 *
 * How it looks is not something a test can judge, and the screenshots are the
 * evidence for that. What is asserted here is the part a later change could
 * quietly undo: that an absent checklist renders as nothing rather than as an
 * empty one, that the trail stays folded, and that the panel gets out of the
 * way when there is a decision to answer.
 */

const at = (secondsAgo: number) => new Date(Date.now() - secondsAgo * 1000).toISOString();

const TRAIL = [
  { at: at(300), text: "Read src/auth/tokens.ts" },
  { at: at(120), text: "Write src/auth/reset.ts" },
  { at: at(4), text: "Bash pnpm test" },
];

const PLAN = [
  { text: "Read the auth module", state: "done" as const },
  { text: "Single-use tokens", state: "doing" as const },
  { text: "Wire the endpoint", state: "todo" as const },
];

const WORKING = row({ label: "reset", status: "working", detail: "Bash pnpm test", activity: TRAIL });

let ui: Cockpit;
afterEach(() => ui?.unmount());

const panel = () => ui.$("#progress");
const fold = () => ui.$<HTMLDetailsElement>("#trail-fold");
const summary = () => fold()?.querySelector("summary");

async function open(fixtures: Parameters<typeof bootCockpit>[0]): Promise<Cockpit> {
  ui = await bootCockpit(fixtures);
  await ui.open(String(fixtures.rows[0].label));
  return ui;
}

describe("the checklist", () => {
  it("renders each step with its state", async () => {
    await open({ rows: [WORKING], plan: PLAN });

    const steps = ui.$$("#plan .step");
    expect(steps.map((s) => s.dataset.state)).toEqual(["done", "doing", "todo"]);
    expect(steps[1].textContent).toContain("Single-use tokens");
  });

  it("renders no checklist at all when the specialist has written none", async () => {
    await open({ rows: [WORKING], plan: null });

    // An empty checklist reads as nothing left to do, which is the opposite
    // of what a specialist that has not written one means.
    expect(ui.$("#plan")).toBeNull();
    expect(panel()).not.toBeNull();
  });

  it("renders no checklist when the plan came back empty either", async () => {
    await open({ rows: [WORKING], plan: [] });
    expect(ui.$("#plan")).toBeNull();
  });

  it("sits above the thread, not under it", async () => {
    await open({ rows: [WORKING], plan: PLAN });

    // It is the answer to the question the cockpit exists for; putting it
    // back under the thread is the change this guards against.
    const order = ui.$$("#stage > *").map((node) => node.id);
    expect(order.indexOf("progress")).toBeLessThan(order.indexOf("thread"));
  });
});

describe("the command trail", () => {
  it("stays folded, and says how much is folded away", async () => {
    await open({ rows: [WORKING], plan: PLAN });

    expect(fold()!.open).toBe(false);
    expect(summary()!.textContent).toContain("Bash pnpm test");
    expect(summary()!.textContent).toContain("ago");
    expect(summary()!.textContent).toContain("2 before it");
  });

  it("carries the newest command, not the oldest", async () => {
    await open({ rows: [WORKING], plan: PLAN });
    expect(summary()!.textContent).not.toContain("Read src/auth/tokens.ts");
  });

  it("does not repeat the summary's line inside the fold", async () => {
    await open({ rows: [WORKING], plan: PLAN });

    const inside = ui.$$("#trail .trail-item").map((li) => li.textContent);
    expect(inside).toHaveLength(2);
    expect(inside.some((text) => text?.includes("Bash pnpm test"))).toBe(false);
    // Newest first: what it did most recently is what you came to look at.
    expect(inside[0]).toContain("Write src/auth/reset.ts");
  });

  it("counts nothing behind it when there is only one command", async () => {
    await open({ rows: [row({ ...WORKING, activity: TRAIL.slice(-1) })], plan: PLAN });
    expect(summary()!.textContent).not.toContain("before it");
  });

  it("is absent when the specialist has run nothing", async () => {
    await open({ rows: [row({ ...WORKING, activity: [] })], plan: PLAN });
    expect(fold()).toBeNull();
    expect(ui.$("#plan")).not.toBeNull();
  });
});

describe("staying out of the way", () => {
  it("shows nothing when there is neither a checklist nor a trail", async () => {
    await open({ rows: [row({ ...WORKING, activity: [] })], plan: null });
    expect(panel()).toBeNull();
  });

  it("hides while a decision is waiting to be answered", async () => {
    const waiting = row({
      label: "reset", status: "awaiting_decision", activity: TRAIL,
      latestReportSeq: 1, answeredReportSeq: null,
    });
    await open({
      rows: [waiting],
      plan: PLAN,
      entries: [entry({ kind: "report", body: "Which expiry?", reportSeq: 1 })],
      decision: decisionSchema.parse({
        kind: "question", title: "Which expiry?", summary: "Your call.",
        options: [{ id: "15m", label: "15 minutes" }],
      }),
    });

    // A finished turn's checklist is stale by definition, and it would sit
    // directly above the thing being asked.
    expect(panel()).toBeNull();
    expect(ui.$("#decision")).not.toBeNull();
  });
});

/**
 * The height of the panel is a stylesheet fact, not a DOM one - jsdom lays
 * nothing out, so the screenshots are the evidence for how it looks. What is
 * worth holding here is the shape of the rule, because it is the shape that
 * regressed: two lists that each capped and scrolled themselves, adding up to
 * a panel that took two thirds of the stage and had two scrollbars in it.
 */
describe("the panel's height", () => {
  // From the root, not from import.meta.url: this file runs under jsdom, so
  // its own URL is the http one the fake document was given.
  const css = readFileSync("src/client/styles.css", "utf8");
  const rule = (selector: string) => {
    const at = css.indexOf(`\n${selector} {`);
    return at === -1 ? "" : css.slice(at, css.indexOf("}", at));
  };

  it("is capped on the panel, so a fifty-step plan cannot take the stage", () => {
    expect(rule("#progress")).toMatch(/max-height:\s*clamp\(/);
    expect(rule("#progress")).toMatch(/overflow-y:\s*auto/);
  });

  it("is capped in px as well as vh, at both ends", () => {
    // A bare vh is two lines and a scrollbar on a short window, and a wall of
    // checklist on a tall one. Both bounds have to be there.
    const [, min, , max] = rule("#progress").match(/clamp\(\s*([\d.]+)px\s*,\s*([\d.]+)vh\s*,\s*([\d.]+)px/) ?? [];
    expect(Number(min)).toBeGreaterThan(0);
    expect(Number(max)).toBeGreaterThan(Number(min));
  });

  it("leaves the lists inside it uncapped, so there is one scroller", () => {
    for (const selector of ["#plan", "#trail"]) {
      expect(rule(selector)).not.toMatch(/max-height/);
      expect(rule(selector)).not.toMatch(/overflow/);
    }
  });
});
