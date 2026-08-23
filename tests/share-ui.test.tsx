/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ShareReport } from "../src/client/components/ShareReport.js";
import { BenchProvider } from "../src/client/components/context.js";
import type { RosterRow } from "../src/shared/types.js";

const row = (id: string, label: string, project = "/var/www/bench"): RosterRow => ({
  id, label, project, status: "awaiting_decision", detail: "ready",
  latestReportSeq: 1, answeredReportSeq: 1, startedAt: null, tokens: 0, activity: [],
});

let root: Root | null = null;
let host: HTMLElement;
let posted: Array<{ url: string; body: any }>;
let selected: Array<string | null>;
let closed: number;

beforeEach(() => {
  posted = [];
  selected = [];
  closed = 0;
  (globalThis as any).fetch = async (url: string, init?: RequestInit) => {
    posted.push({ url, body: JSON.parse(String(init?.body ?? "{}")) });
    return { ok: true, status: 200, json: async () => ({ sent: 1 }) } as any;
  };
  host = document.createElement("div");
  document.body.appendChild(host);
});

afterEach(() => { act(() => root?.unmount()); root = null; host.remove(); });

function render(rows: RosterRow[], sessionId = "s1") {
  act(() => {
    root = createRoot(host);
    root.render(
      <BenchProvider
        state={{ rows, selectedId: sessionId }}
        actions={{ select: (id: string | null) => selected.push(id), closeSpecialist() {} }}
      >
        <ShareReport
          sessionId={sessionId}
          seq={2}
          file="report.html"
          onShared={() => { closed += 1; }}
        />
      </BenchProvider>,
    );
  });
}

const openButton = () => host.querySelector<HTMLButtonElement>(".share-open");
const targets = () => [...host.querySelectorAll<HTMLButtonElement>(".share-menu button")];

describe("sharing a report", () => {
  it("offers the other specialists", () => {
    render([row("s1", "author"), row("s2", "reviewer"), row("s3", "ui-designer")]);
    act(() => { openButton()!.click(); });

    expect(targets().map((b) => b.textContent)).toEqual(
      expect.arrayContaining([expect.stringContaining("reviewer")]),
    );
    expect(targets()).toHaveLength(2);
  });

  it("never offers to share a report back to whoever wrote it", () => {
    render([row("s1", "author"), row("s2", "reviewer")]);
    act(() => { openButton()!.click(); });

    expect(targets().some((b) => b.textContent?.includes("author"))).toBe(false);
  });

  it("says nothing at all when there is nobody to share with", () => {
    // One specialist on the roster is the common case early on, and a button
    // that can only fail is worse than no button.
    render([row("s1", "author")]);
    expect(openButton()).toBeNull();
  });

  it("shares to the one that was picked", async () => {
    render([row("s1", "author"), row("s2", "reviewer")]);
    act(() => { openButton()!.click(); });
    await act(async () => { targets()[0].click(); });

    expect(posted).toHaveLength(1);
    expect(posted[0].url).toBe("/api/sessions/s1/share");
    expect(posted[0].body).toMatchObject({ seq: 2, file: "report.html", to: ["s2"] });
  });

  it("goes to whoever it was shared with", async () => {
    // Sharing starts a turn on somebody else, and them reading it is the
    // thing worth watching next - not the report you have finished with.
    render([row("s1", "author"), row("s2", "reviewer")]);
    act(() => { openButton()!.click(); });
    await act(async () => { targets()[0].click(); });

    expect(selected).toEqual(["s2"]);
  });

  it("closes the report on its way there", async () => {
    render([row("s1", "author"), row("s2", "reviewer")]);
    act(() => { openButton()!.click(); });
    await act(async () => { targets()[0].click(); });

    expect(closed).toBe(1);
    expect(targets()).toHaveLength(0);
  });

  it("stays put when the share failed", async () => {
    (globalThis as any).fetch = async () => ({ ok: false, status: 500, json: async () => ({}) });
    render([row("s1", "author"), row("s2", "reviewer")]);
    act(() => { openButton()!.click(); });
    await act(async () => { targets()[0].click(); });

    expect(selected).toEqual([]);
    expect(closed).toBe(0);
  });

  it("does not offer a specialist working on another project", () => {
    // A report is about one codebase. A specialist elsewhere has no worktree
    // it applies to - it would be reading a file about somebody else's repo.
    render([
      row("s1", "author"),
      row("s2", "reviewer"),
      row("s3", "general", "/var/www/fulacx-enterprise"),
    ]);
    act(() => { openButton()!.click(); });

    expect(targets()).toHaveLength(1);
    expect(targets()[0].textContent).toContain("reviewer");
  });

  it("says nothing when the only others are on different projects", () => {
    render([row("s1", "author"), row("s2", "general", "/var/www/teledoctor")]);
    expect(openButton()).toBeNull();
  });
});
