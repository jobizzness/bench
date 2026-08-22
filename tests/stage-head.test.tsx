/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, afterEach } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import { StageHead } from "../src/client/components/StageHead.js";
import type { RosterRow } from "../src/shared/types.js";
import { STATE_EVENT } from "../src/client/bench.js";

const row = (over: Partial<RosterRow> = {}): RosterRow => ({
  id: "s1", label: "auth", project: "/p", status: "awaiting_decision",
  detail: "waiting on you", latestReportSeq: null, answeredReportSeq: null,
  startedAt: null, tokens: 0, activity: [], ...over,
});

let root: Root | null = null;
afterEach(() => { act(() => root?.unmount()); root = null; delete (window as any).bench; });

function render(rows: RosterRow[], selectedId: string | null): HTMLElement {
  (window as any).bench = { state: { rows, selectedId }, select() {}, closeSpecialist() {} };
  const host = document.createElement("div");
  document.body.appendChild(host);
  act(() => { root = createRoot(host); root.render(<StageHead />); });
  act(() => { document.dispatchEvent(new CustomEvent(STATE_EVENT)); });
  return host;
}

describe("StageHead", () => {
  it("names the specialist and what it is doing", () => {
    const host = render([row()], "s1");
    expect(host.querySelector("#stage-label")!.textContent).toBe("auth");
    // The detail is the useful half: "awaiting decision" alone says nothing
    // about whether there is anything to read.
    expect(host.querySelector("#stage-status")!.textContent)
      .toBe("awaiting decision · waiting on you");
  });

  it("renders nothing when no specialist is selected", () => {
    expect(render([row()], null).querySelector("#stage-head")).toBeNull();
  });

  it("renders nothing when the selection is not on the roster", () => {
    expect(render([row()], "gone").querySelector("#stage-head")).toBeNull();
  });
});
