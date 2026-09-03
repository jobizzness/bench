/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Decision } from "../src/shared/types.js";
import { row } from "./helpers/cockpit.js";

/**
 * `loadArtifact` rejecting - a relayed report the daemon could not reach, or
 * a local one the browser refused - used to be `void promise.then(...)` with
 * no `.catch()`: `content` stayed null forever (the same empty bordered box
 * as still-loading) and the rejection went unhandled (#60).
 */
const { loadArtifact } = vi.hoisted(() => ({ loadArtifact: vi.fn() }));
vi.mock("../src/client/api.js", () => ({ loadArtifact }));

const { useReportFrame } = await import("../src/client/components/useReportFrame.js");
const { PhoneUnblock } = await import("../src/client/components/PhoneUnblock.js");

let root: Root | null = null;
let host: HTMLElement | null = null;
let latest: ReturnType<typeof useReportFrame> | "unset" = "unset";

function Probe({ sessionId, seq }: { sessionId: string; seq: number }) {
  latest = useReportFrame(sessionId, seq);
  return null;
}

function mount(sessionId: string, seq: number): void {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => { root!.render(<Probe sessionId={sessionId} seq={seq} />); });
}

afterEach(() => {
  act(() => { root?.unmount(); });
  host?.remove();
  root = null;
  host = null;
  latest = "unset";
  loadArtifact.mockReset();
});

describe("useReportFrame when the report cannot be loaded", () => {
  it("says the load failed rather than leaving content null forever", async () => {
    loadArtifact.mockRejectedValue(new TypeError("fetch failed"));
    mount("s1", 3);
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    expect(latest).not.toBe("unset");
    expect((latest as { content: unknown }).content).toBeNull();
    expect((latest as { failed: boolean }).failed).toBe(true);
  });

  it("is not marked failed once a load succeeds", async () => {
    loadArtifact.mockResolvedValue({ kind: "url", url: "http://d/r/s1/3/report.html" });
    mount("s1", 3);
    await act(async () => { await Promise.resolve(); });

    expect((latest as { failed: boolean }).failed).toBe(false);
    expect((latest as { content: unknown }).content).toEqual({ kind: "url", url: "http://d/r/s1/3/report.html" });
  });
});

const plain: Decision = {
  kind: "completion",
  title: "Ship it?",
  summary: "Built and pushed.",
  options: [{ id: "ship", label: "Merge it" }],
  questions: [],
  allowFreeText: true,
};

describe("PhoneUnblock when the report cannot be loaded", () => {
  it("shows an honest message rather than an empty box, and the options still work", async () => {
    loadArtifact.mockRejectedValue(new TypeError("fetch failed"));
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root!.render(
        <PhoneUnblock
          row={row({ id: "a", latestReportSeq: 1 })}
          decision={plain}
          waitingCount={1}
          onAnswered={() => {}}
          onBrowseRoster={() => {}}
        />,
      );
    });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    expect(host.querySelector("#unblock-report-failed")).not.toBeNull();
    expect(host.querySelector("#unblock-frame")).toBeNull();
    expect(host.querySelector("#unblock-options .option")).not.toBeNull();
  });
});
