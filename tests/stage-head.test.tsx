/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import { StageHead } from "../src/client/components/StageHead.js";
import type { RosterRow } from "../src/shared/types.js";
import { BenchProvider } from "../src/client/components/context.js";

const row = (over: Partial<RosterRow> = {}): RosterRow => ({
  id: "s1", label: "auth", role: "specialist", branch: "bench/auth-abcd1234", isolated: true,
  project: "/p", status: "awaiting_decision",
  detail: "waiting on you", latestReportSeq: null, answeredReportSeq: null,
  startedAt: null, tokens: 0, activity: [], ...over,
});

let root: Root | null = null;
afterEach(() => { act(() => root?.unmount()); root = null; });

// StageHead mounts the five-hour usage bar, which asks the daemon on its
// own. Stubbed rather than left real, the way every other component test
// here stubs fetch, so a mounted specialist does not reach the network.
const realFetch = globalThis.fetch;
beforeEach(() => {
  globalThis.fetch = (async () => ({
    ok: true,
    status: 200,
    json: async () => ({ available: false, reason: "none" }),
  })) as typeof fetch;
});
afterEach(() => { globalThis.fetch = realFetch; });

const actions = { select() {}, closeSpecialist() {} };

// jsdom has no real viewport, so `useNarrowViewport` (Meta.tsx's phone
// branch) is fed a fake `matchMedia` here rather than a resize - same
// pattern as `tests/phone-landing.test.tsx`.
function setNarrow(narrow: boolean): void {
  (window as unknown as { matchMedia: (query: string) => MediaQueryList }).matchMedia = ((query: string) => ({
    matches: narrow,
    media: query,
    onchange: null,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent: () => false,
  })) as unknown as (query: string) => MediaQueryList;
}
afterEach(() => setNarrow(false));

function render(rows: RosterRow[], selectedId: string | null): HTMLElement {
  const host = document.createElement("div");
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host);
    root.render(
      <BenchProvider state={{ rows, selectedId }} actions={actions}>
        <StageHead onGithub={() => {}} />
      </BenchProvider>,
    );
  });
  return host;
}

describe("StageHead", () => {
  it("names the specialist and what it is doing", () => {
    const host = render([row()], "s1");
    expect(host.querySelector("#stage-label")!.textContent).toBe("auth");
    // Badges under the name, then the prose: what kind of agent, what state,
    // which branch - then what it is actually doing. The detail is the useful
    // half; "awaiting decision" alone says nothing about whether there is
    // anything to read.
    expect([...host.querySelectorAll(".meta > *")].map((s) => s.textContent))
      .toEqual(["specialist", "awaiting decision", "bench/auth-abcd1234", "waiting on you"]);
  });

  it("renders nothing when no specialist is selected", () => {
    expect(render([row()], null).querySelector("#stage-head")).toBeNull();
  });

  it("renders nothing when the selection is not on the roster", () => {
    expect(render([row()], "gone").querySelector("#stage-head")).toBeNull();
  });

  describe("below the phone breakpoint (#64)", () => {
    it("carries only the role, the checkout warning and the live line - not status, spend or branch", () => {
      setNarrow(true);
      const host = render(
        [row({ spend: { dollars: 12.5, turns: 2, billed: "account" }, isolated: false })],
        "s1",
      );
      const facts = host.querySelector(".meta-phone-facts")!;
      expect(facts.textContent).toContain("specialist");
      expect(facts.textContent).toContain("in your checkout");
      expect(facts.textContent).not.toContain("awaiting decision");
      expect(facts.textContent).not.toContain("bench/auth-abcd1234");
      expect(facts.textContent).not.toContain("12.5");
      expect(host.querySelector(".meta-phone-detail")!.textContent).toBe("waiting on you");
    });

    it("rephrases a working turn's raw tool call into words", () => {
      setNarrow(true);
      const host = render([row({ status: "working", detail: "Bash pnpm deploy:web" })], "s1");
      expect(host.querySelector(".meta-phone-detail")!.textContent).toBe("Running a command");
    });

    it("marks a crashed or provisioning_failed specialist so its line can be coloured `--broken` - the status chip that used to say this is gone", () => {
      setNarrow(true);
      const crashed = render([row({ status: "crashed", detail: "whatever the CLI said last" })], "s1");
      expect(crashed.querySelector(".meta-phone-detail")!.getAttribute("data-status")).toBe("crashed");

      const failed = render([row({ status: "provisioning_failed", detail: "no space left on device" })], "s1");
      expect(failed.querySelector(".meta-phone-detail")!.getAttribute("data-status")).toBe("provisioning_failed");

      const healthy = render([row({ status: "working", detail: "Bash ls" })], "s1");
      expect(healthy.querySelector(".meta-phone-detail")!.getAttribute("data-status")).toBe("working");
    });
  });
});
