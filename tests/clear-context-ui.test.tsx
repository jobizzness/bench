/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ClearContext } from "../src/client/components/ClearContext.js";
import { Meta } from "../src/client/components/Meta.js";
import type { RosterRow } from "../src/shared/types.js";

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

function renderClear(id: string) {
  act(() => {
    root = createRoot(host);
    root.render(<ClearContext id={id} />);
  });
}

const button = () => host.querySelector<HTMLButtonElement>("#stage-clear");

describe("clearing a conversation from the header", () => {
  it("posts to the clear route when pressed", async () => {
    renderClear("s1");
    await act(async () => { button()!.click(); });

    expect(posted).toEqual([{ url: "/api/sessions/s1/clear", method: "POST" }]);
  });

  it("cannot be pressed twice while the process is going down", async () => {
    renderClear("s1");
    await act(async () => {
      button()!.click();
      button()!.click();
    });

    expect(posted).toHaveLength(1);
  });

  it("says what it is doing, not just that it was clicked", async () => {
    renderClear("s1");
    expect(button()!.textContent).toBe("clear context");
  });
});

const row = (over: Partial<RosterRow> = {}): RosterRow => ({
  id: "s1", label: "auth", project: "/p", status: "working", branch: "b",
  detail: "Bash pnpm test", latestReportSeq: null, answeredReportSeq: null,
  context: null, startedAt: new Date().toISOString(), tokens: 0, activity: [],
  ...over,
});

function renderMeta(r: RosterRow, header = true) {
  act(() => {
    root = createRoot(host);
    root.render(
      header
        ? <Meta row={r} status branch badges onRole={() => {}} />
        : <Meta row={r} />,
    );
  });
}

describe("the clear control on the header", () => {
  it("is offered once there is a conversation to forget", () => {
    renderMeta(row({ context: { used: 1000, window: 200_000 } }));
    expect(button()).not.toBeNull();
  });

  it("is not offered to a specialist that has never run a turn", () => {
    renderMeta(row({ context: null }));
    expect(button()).toBeNull();
  });

  it("is not offered on a roster row, only on the header", () => {
    renderMeta(row({ context: { used: 1000, window: 200_000 } }), false);
    expect(button()).toBeNull();
  });
});
