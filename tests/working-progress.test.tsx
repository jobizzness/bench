/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, afterEach } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import type { PlanStep } from "../src/daemon/plan.js";
import type { RosterRow } from "../src/shared/types.js";
import { Working, fractionDone } from "../src/client/components/Working.js";
import { BenchProvider } from "../src/client/components/context.js";

/**
 * A turn has no known length, so the only honest measure of one is the
 * specialist's own checklist. What these hold in place is when the bar
 * refuses to be drawn at all.
 */

const row = (over: Partial<RosterRow> = {}): RosterRow => ({
  id: "s1", label: "auth", role: "specialist", branch: "b", isolated: true,
  project: "/p", status: "working", detail: "Edit styles.css",
  latestReportSeq: null, answeredReportSeq: null,
  startedAt: new Date().toISOString(), tokens: 0, activity: [], ...over,
});

const step = (state: PlanStep["state"]): PlanStep => ({ text: "a step", state });

let root: Root | null = null;
afterEach(() => { act(() => root?.unmount()); root = null; });

function render(steps: PlanStep[] | null, over: Partial<RosterRow> = {}): HTMLElement {
  const host = document.createElement("div");
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host);
    root.render(
      <BenchProvider
        state={{ rows: [row(over)], selectedId: "s1" }}
        actions={{ select() {}, closeSpecialist() {} }}
      >
        <Working steps={steps} />
      </BenchProvider>,
    );
  });
  return host;
}

const bar = (host: HTMLElement) => host.querySelector<HTMLElement>("#working-progress");

describe("how far through a turn is", () => {
  it("fills to the fraction of the checklist that is done", () => {
    const host = render([step("done"), step("done"), step("doing"), step("todo")]);

    expect(bar(host)!.style.width).toBe("50%");
    expect(host.querySelector("#working-steps")!.textContent).toBe("2 of 4");
  });

  it("counts only what is done, not what is under way", () => {
    // A step marked doing is visible in the checklist above. Counting it as
    // half would move the bar by inventing a number nobody wrote.
    expect(fractionDone([step("done"), step("doing")])).toBe(0.5);
  });

  it("draws nothing when the specialist has written no checklist", () => {
    // Most short turns have none, and the sweep on the seam covers those.
    expect(render(null)).toBeTruthy();
    expect(bar(render(null))).toBeNull();
    expect(bar(render([]))).toBeNull();
  });

  it("draws nothing when every step is done", () => {
    // Not modesty: the daemon falls back to the most recent plan on disk when
    // this turn has not written one, so a full bar at the start of a turn is
    // last turn's bar. A bar that only appears while there is work left
    // cannot tell that lie.
    expect(fractionDone([step("done"), step("done")])).toBeNull();
    expect(bar(render([step("done")]))).toBeNull();
  });

  it("says what it is measuring, for anything not reading pixels", () => {
    const host = render([step("done"), step("todo"), step("todo")]);
    const drawn = bar(host)!;

    expect(drawn.getAttribute("role")).toBe("progressbar");
    expect(drawn.getAttribute("aria-valuenow")).toBe("1");
    expect(drawn.getAttribute("aria-valuemax")).toBe("3");
  });

  it("is not there at all when no turn is running", () => {
    expect(render([step("todo")], { status: "done" }).querySelector("#working")).toBeNull();
  });
});
