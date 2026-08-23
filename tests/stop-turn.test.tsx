/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Working } from "../src/client/components/Working.js";
import { BenchProvider } from "../src/client/components/context.js";
import type { RosterRow } from "../src/shared/types.js";

const row = (over: Partial<RosterRow> = {}): RosterRow => ({
  id: "s1", label: "auth", project: "/p", status: "working",
  detail: "Bash pnpm test", latestReportSeq: null, answeredReportSeq: null,
  startedAt: new Date().toISOString(), tokens: 0, activity: [], ...over,
});

let root: Root | null = null;
let host: HTMLElement;
let posted: Array<{ url: string; method?: string }>;

beforeEach(() => {
  posted = [];
  (globalThis as any).fetch = async (url: string, init?: RequestInit) => {
    posted.push({ url, method: init?.method });
    return { ok: true, status: 200, json: async () => ({ ok: true }) } as any;
  };
  host = document.createElement("div");
  document.body.appendChild(host);
});

afterEach(() => { act(() => root?.unmount()); root = null; host.remove(); });

function render(r: RosterRow | null) {
  const rows = r ? [r] : [];
  act(() => {
    root = createRoot(host);
    root.render(
      <BenchProvider
        state={{ rows, selectedId: r?.id ?? null }}
        actions={{ select() {}, closeSpecialist() {} }}
      >
        <Working />
      </BenchProvider>,
    );
  });
}

const button = () => host.querySelector<HTMLButtonElement>("#stop-turn");

describe("stopping a turn", () => {
  it("offers a way out while a turn is running", () => {
    // Before this the only exit from a turn going nowhere was closing the
    // specialist, which takes its worktree with it.
    render(row());
    expect(button()).not.toBeNull();
  });

  it("ends the turn when pressed", async () => {
    render(row());
    await act(async () => { button()!.click(); });

    expect(posted).toHaveLength(1);
    expect(posted[0].url).toBe("/api/sessions/s1/stop");
    expect(posted[0].method).toBe("POST");
  });

  it("cannot be pressed twice while the process is going down", async () => {
    render(row());
    await act(async () => {
      button()!.click();
      button()!.click();
    });

    expect(posted).toHaveLength(1);
  });

  it("is not offered while a worktree is still being built", () => {
    // Stopping provisioning leaves half a checkout behind.
    render(row({ status: "provisioning" }));
    expect(button()).toBeNull();
  });

  it("is not offered to a specialist that is not running", () => {
    render(row({ status: "awaiting_decision", detail: "waiting on you" }));
    expect(host.querySelector("#working")).toBeNull();
  });
});
