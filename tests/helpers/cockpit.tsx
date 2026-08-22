import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { App } from "../../src/client/components/App.js";
import type { PlanStep } from "../../src/daemon/plan.js";
import type { Decision, RosterRow, ThreadEntry } from "../../src/shared/types.js";
import { waitFor } from "./wait-for.js";

/**
 * Boots the real cockpit against a stubbed daemon.
 *
 * Component tests that mount one component and assert on its markup only
 * prove the markup. The intake is worth more than that: what matters is that
 * a key press reaches the right question, that the send bar refuses, and that
 * the body posted at the end says which answers the developer actually gave.
 * That is <App /> or nothing.
 */

export interface Sent { url: string; body: any }

export interface Fixtures {
  rows: RosterRow[];
  entries?: ThreadEntry[];
  decision?: Decision | null;
  projects?: Array<{ name: string; path: string }>;
  /** null is a specialist that has written no checklist at all. */
  plan?: PlanStep[] | null;
  /** The id the daemon hands back from POST /api/sessions. */
  createdId?: string;
}

export interface Cockpit {
  sent: Sent[];
  /** Push a roster over the socket, as the daemon does. */
  roster: (rows: RosterRow[]) => Promise<void>;
  /** Click a roster row, as the developer does. */
  open: (label: string) => Promise<void>;
  press: (key: string) => Promise<void>;
  /** Do something to the DOM directly and let React settle after it. */
  run: (fn: () => void) => Promise<void>;
  /** A key struck while the caret is in a field, which is where it bubbles from. */
  pressIn: (element: Element | null | undefined, key: string) => Promise<void>;
  click: (element: Element | null | undefined) => Promise<void>;
  type: (input: Element | null | undefined, value: string) => Promise<void>;
  $: <T extends Element>(selector: string) => T | null;
  $$: (selector: string) => HTMLElement[];
  unmount: () => void;
}

export const row = (over: Partial<RosterRow> = {}): RosterRow => ({
  id: "s1", label: "auth", project: "/var/www/demo", status: "awaiting_decision",
  detail: "ready", latestReportSeq: null, answeredReportSeq: null,
  startedAt: null, tokens: 0, activity: [], ...over,
});

export const entry = (over: Partial<ThreadEntry> = {}): ThreadEntry => ({
  seq: 1, at: new Date().toISOString(), kind: "user", body: "do the thing", ...over,
});

/** jsdom reflects `open` but implements neither method the dialog needs. */
function polyfillDialogs(): void {
  const proto = (globalThis as any).HTMLDialogElement?.prototype;
  if (!proto || proto.showModal) return;

  proto.showModal = function showModal(this: HTMLDialogElement) {
    this.setAttribute("open", "");
  };
  proto.close = function close(this: HTMLDialogElement) {
    if (!this.hasAttribute("open")) return;
    this.removeAttribute("open");
    this.dispatchEvent(new Event("close"));
  };
}

export async function bootCockpit(fixtures: Fixtures): Promise<Cockpit> {
  polyfillDialogs();

  const sent: Sent[] = [];
  let socket: any = null;

  (globalThis as any).WebSocket = class {
    onmessage: ((e: { data: string }) => void) | null = null;
    onclose: ((e: { code: number }) => void) | null = null;
    constructor() { socket = this; }
    send() {}
    close() {}
  };

  (globalThis as any).fetch = async (url: string, init?: RequestInit) => {
    if (init?.method === "POST") {
      sent.push({ url, body: JSON.parse(String(init.body)) });
      // Creating a specialist answers with its id, and the cockpit acts on it.
      const created = url.endsWith("/api/sessions") ? { id: fixtures.createdId ?? "s-new" } : {};
      return { ok: true, status: 200, json: async () => ({ ok: true, ...created }) };
    }
    if (url.includes("/thread")) {
      return { ok: true, status: 200, json: async () => ({ entries: fixtures.entries ?? [] }) };
    }
    if (url.includes("/report/")) {
      return {
        ok: fixtures.decision != null,
        status: fixtures.decision != null ? 200 : 404,
        json: async () => ({ seq: 1, decision: fixtures.decision, malformed: false }),
      };
    }
    if (url.includes("/projects")) {
      return { ok: true, status: 200, json: async () => ({ projects: fixtures.projects ?? [] }) };
    }
    if (url.includes("/plan")) {
      const plan = fixtures.plan;
      return plan === null || plan === undefined
        ? { ok: false, status: 404, json: async () => ({}) }
        : { ok: true, status: 200, json: async () => ({ steps: plan }) };
    }
    return { ok: true, status: 200, json: async () => ({}) };
  };

  const host = document.createElement("div");
  document.body.appendChild(host);

  let root: Root;
  await act(async () => { root = createRoot(host); root.render(<App />); });

  const $ = <T extends Element>(selector: string) => host.querySelector<T>(selector);
  const $$ = (selector: string) => [...host.querySelectorAll<HTMLElement>(selector)];

  const settle = async () => { await act(async () => { await Promise.resolve(); }); };

  const cockpit: Cockpit = {
    sent,
    $, $$,
    roster: async (rows) => {
      await act(async () => {
        socket?.onmessage?.({ data: JSON.stringify({ type: "roster", rows }) });
      });
      await settle();
    },
    open: async (label) => {
      const target = $$(".row").find((node) => node.querySelector(".label")?.textContent === label);
      if (!target) throw new Error(`no roster row labelled ${label}`);
      await act(async () => { target.click(); });
      await settle();
      await waitFor(() => $("#thread"), "the thread");
    },
    press: async (key) => {
      await act(async () => {
        document.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
      });
      await settle();
    },
    run: async (fn) => { await act(async () => { fn(); }); await settle(); },
    pressIn: async (element, key) => {
      if (!element) throw new Error("nothing to press a key in");
      await act(async () => {
        element.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
      });
      await settle();
    },
    click: async (element) => {
      if (!element) throw new Error("nothing to click");
      await act(async () => { (element as HTMLElement).click(); });
      await settle();
    },
    type: async (input, value) => {
      if (!input) throw new Error("nothing to type into");
      const field = input as HTMLInputElement;
      await act(async () => {
        // React listens for input on its own value tracker, so the setter has
        // to be the native one or the change never reaches state.
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
        setter.call(field, value);
        field.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await settle();
    },
    unmount: () => { act(() => root.unmount()); host.remove(); },
  };

  await cockpit.roster(fixtures.rows);
  return cockpit;
}
