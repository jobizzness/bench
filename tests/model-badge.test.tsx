/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, afterEach } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import { Meta } from "../src/client/components/Meta.js";
import type { RosterRow } from "../src/shared/types.js";

const row = (over: Partial<RosterRow> = {}): RosterRow => ({
  id: "s1", label: "auth", role: "specialist", branch: "bench/auth-abcd1234",
  isolated: true, project: "/p", model: "opus", status: "working",
  detail: "Bash", latestReportSeq: null, answeredReportSeq: null,
  startedAt: null, tokens: 0, context: null, activity: [], ...over,
});

let root: Root | null = null;
afterEach(() => { act(() => root?.unmount()); root = null; });

function render(node: React.ReactNode): HTMLElement {
  const host = document.createElement("div");
  document.body.appendChild(host);
  act(() => { root = createRoot(host); root.render(node); });
  return host;
}

const badge = (host: HTMLElement) => host.querySelector(".badge-model")?.textContent;

describe("what a specialist is running on", () => {
  it("is on the row, under the name", () => {
    // Four models to choose from, chosen once, at a moment you are not
    // looking at the roster. The row is where you see the answer.
    expect(badge(render(<Meta row={row({ model: "haiku" })} />))).toBe("Haiku 4.5");
  });

  it("is on the header too", () => {
    expect(badge(render(<Meta row={row({ model: "sonnet" })} status branch badges />))).toBe("Sonnet 5");
  });

  it("comes last on the row, after what it is doing", () => {
    const host = render(<Meta row={row()} />);
    expect([...host.querySelectorAll(".meta > *")].map((s) => s.textContent))
      .toEqual(["specialist", "Bash", "Opus 5"]);
  });

  it("shows a model this cockpit has never heard of as itself", () => {
    // The CLI takes full model names, and a specialist created with one is
    // still a specialist. Showing nothing would be a lie about the row.
    expect(badge(render(<Meta row={row({ model: "claude-fable-5" })} />))).toBe("claude-fable-5");
  });

  it("says nothing at all when the row does not carry one", () => {
    const { model, ...older } = row();
    expect(badge(render(<Meta row={older as RosterRow} />))).toBeUndefined();
  });
});
