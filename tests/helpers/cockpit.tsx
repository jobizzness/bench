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
  /** House rules already on the daemon when the page opens. */
  settings?: { codingStyle: string; workflowRules: string; reviewModel?: string };
  /** What GitHub says about the project the drawer is opened on. */
  github?: { slug: string | null; items: unknown[] };
  /** Where else this daemon answers. */
  addresses?: { origins: string[]; loopbackOnly: boolean };
  /** The Anthropic key the daemon is already holding, if any. */
  apiKey?: { present: boolean; hint: string };
  /** What the daemon says when a key is offered to it. */
  keyReply?: { status: number; body: unknown };
}

export interface Cockpit {
  sent: Sent[];
  /** Every URL the page asked for, GETs included. */
  fetched: string[];
  /** Push a roster over the socket, as the daemon does. */
  roster: (rows: RosterRow[]) => Promise<void>;
  /** The socket opening, which is the page learning the daemon is there. */
  connect: () => Promise<void>;
  /** The socket going. 1006 is a daemon that died; 1008 is a refused token. */
  drop: (code?: number) => Promise<void>;
  /** Click a roster row, as the developer does. */
  open: (label: string) => Promise<void>;
  press: (key: string) => Promise<void>;
  /** Do something to the DOM directly and let React settle after it. */
  run: (fn: () => void) => Promise<void>;
  /** A key struck while the caret is in a field, which is where it bubbles from. */
  pressIn: (
    element: Element | null | undefined,
    key: string,
    modifiers?: { shiftKey?: boolean },
  ) => Promise<void>;
  click: (element: Element | null | undefined) => Promise<void>;
  type: (input: Element | null | undefined, value: string) => Promise<void>;
  /** Choose an option in a <select>, which React tracks separately. */
  pick: (select: Element | null | undefined, value: string) => Promise<void>;
  $: <T extends Element>(selector: string) => T | null;
  $$: (selector: string) => HTMLElement[];
  unmount: () => void;
}

export const row = (over: Partial<RosterRow> = {}): RosterRow => ({
  id: "s1", label: "auth", role: "specialist", branch: "bench/auth-abcd1234", isolated: true,
  project: "/var/www/demo", model: "opus", status: "awaiting_decision",
  detail: "ready", latestReportSeq: null, answeredReportSeq: null,
  startedAt: null, tokens: 0, context: null, activity: [], ...over,
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
  const fetched: string[] = [];
  let socket: any = null;

  (globalThis as any).WebSocket = class {
    onopen: (() => void) | null = null;
    onmessage: ((e: { data: string }) => void) | null = null;
    onclose: ((e: { code: number }) => void) | null = null;
    constructor() { socket = this; }
    send() {}
    close() {}
  };

  (globalThis as any).fetch = async (url: string, init?: RequestInit) => {
    fetched.push(url);

    // Its own branch above the rest: the key has a route per verb, and what
    // comes back from a save is what the page shows.
    if (url.includes("/anthropic-key")) {
      const method = init?.method ?? "GET";
      if (method !== "GET") sent.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null });
      if (method === "DELETE") {
        return { ok: true, status: 200, json: async () => ({ present: false, hint: "", verified: true }) };
      }
      if (method === "POST") {
        const reply = fixtures.keyReply;
        const key = String(JSON.parse(String(init?.body)).key ?? "");
        return {
          ok: (reply?.status ?? 200) < 400,
          status: reply?.status ?? 200,
          json: async () => reply?.body ?? { present: true, hint: "…" + key.slice(-4), verified: true },
        };
      }
      const held = fixtures.apiKey ?? { present: false, hint: "" };
      return { ok: true, status: 200, json: async () => ({ ...held, verified: true }) };
    }

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
    if (url.includes("/github")) {
      const github = fixtures.github;
      return {
        ok: true,
        status: 200,
        json: async () => ({ slug: github?.slug ?? null, items: github?.items ?? [] }),
      };
    }
    if (url.includes("/addresses")) {
      const where = fixtures.addresses;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          origins: where?.origins ?? ["http://127.0.0.1:7420"],
          loopbackOnly: where?.loopbackOnly ?? true,
        }),
      };
    }
    if (url.includes("/settings")) {
      const settings = fixtures.settings ?? { codingStyle: "", workflowRules: "", reviewModel: "opus" };
      return { ok: true, status: 200, json: async () => ({ settings }) };
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
    fetched,
    $, $$,
    roster: async (rows) => {
      await act(async () => {
        socket?.onmessage?.({ data: JSON.stringify({ type: "roster", rows }) });
      });
      await settle();
    },
    connect: async () => {
      await act(async () => { socket?.onopen?.(); });
      await settle();
    },
    drop: async (code = 1006) => {
      await act(async () => { socket?.onclose?.({ code }); });
      await settle();
    },
    open: async (label) => {
      // The label now carries a role badge beside the name, so match the name
      // itself rather than everything inside the line.
      const target = $$(".row").find(
        (node) => node.querySelector(".label")?.firstChild?.textContent === label,
      );
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
    pressIn: async (element, key, modifiers = {}) => {
      if (!element) throw new Error("nothing to press a key in");
      await act(async () => {
        element.dispatchEvent(
          new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...modifiers }),
        );
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
      const field = input as HTMLInputElement | HTMLTextAreaElement;
      await act(async () => {
        // React listens for input on its own value tracker, so the setter has
        // to be the native one or the change never reaches state - and it has
        // to come off the right prototype, or the tracker never notices.
        const proto = field instanceof HTMLTextAreaElement
          ? HTMLTextAreaElement.prototype
          : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, "value")!.set!;
        setter.call(field, value);
        field.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await settle();
    },
    pick: async (select, value) => {
      if (!select) throw new Error("nothing to pick in");
      const field = select as HTMLSelectElement;
      await act(async () => {
        const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!;
        setter.call(field, value);
        field.dispatchEvent(new Event("change", { bubbles: true }));
      });
      await settle();
    },
    unmount: () => { act(() => root.unmount()); host.remove(); },
  };

  await cockpit.roster(fixtures.rows);
  return cockpit;
}
