/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useSelfUpdate, type SelfUpdate } from "../src/client/components/useSelfUpdate.js";
import type { SelfUpdateStatus } from "../src/shared/self-update.js";

/**
 * The button's own life around a slow `POST /api/update` (#150): a request
 * that outlives the client is not a failed update, and what the button says
 * while one is running comes from the pushed status, not from tapping it -
 * see the ticket for the real timeout this reproduces (`UND_ERR_HEADERS_TIMEOUT`
 * on a cold-store build).
 */

let root: Root | null = null;
let host: HTMLElement | null = null;
let latest: SelfUpdate | null = null;

function Probe({ status }: { status: SelfUpdateStatus | null }) {
  latest = useSelfUpdate(status, []);
  return null;
}

function mount(status: SelfUpdateStatus | null): void {
  host = document.createElement("div");
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host!);
    root!.render(<Probe status={status} />);
  });
}

function push(status: SelfUpdateStatus | null): void {
  act(() => { root!.render(<Probe status={status} />); });
}

const realFetch = globalThis.fetch;
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  latest = null;
  globalThis.fetch = realFetch;
});

const updateStatus = (over: Partial<SelfUpdateStatus> = {}): SelfUpdateStatus => ({
  action: { kind: "update", behind: 2 },
  fetchError: null,
  running: false,
  runError: null,
  ...over,
});

describe("useSelfUpdate - a slow update outliving the client (#150)", () => {
  it("does not report failure when the request rejects - the daemon may still be running it", async () => {
    globalThis.fetch = (async () => { throw new TypeError("UND_ERR_HEADERS_TIMEOUT"); }) as typeof fetch;

    mount(updateStatus());
    await act(async () => { await latest!.onTap(); });

    expect(latest!.fieldNote).toBeNull();
  });

  it("shows busy from the pushed status, not from having tapped", async () => {
    let resolveFetch: ((r: Response) => void) | undefined;
    globalThis.fetch = (() => new Promise<Response>((resolve) => { resolveFetch = resolve; })) as unknown as typeof fetch;

    mount(updateStatus());
    expect(latest!.busy).toBe(false);

    let tapped: Promise<void> | undefined;
    act(() => { tapped = latest!.onTap() as unknown as Promise<void>; });
    // The request is still pending and nothing has been pushed yet - busy
    // stays false rather than flipping the instant the button was tapped.
    expect(latest!.busy).toBe(false);

    push(updateStatus({ running: true }));
    expect(latest!.busy).toBe(true);

    resolveFetch?.(new Response(JSON.stringify({ ok: true }), { status: 202 }));
    await act(async () => { await tapped; });

    push(updateStatus({ running: false }));
    expect(latest!.busy).toBe(false);
  });

  it("shows a refusal that reached the pushed status, not the response body", () => {
    mount(updateStatus({ runError: "pnpm build failed (exit 1) - rolled the checkout back to 1ae2872. See update.log" }));

    expect(latest!.fieldNote).toMatch(/pnpm build failed/);
  });

  it("reflects a run already in flight on first mount - a reload mid-update does not lose it", () => {
    mount(updateStatus({ running: true }));

    expect(latest!.busy).toBe(true);
  });
});
