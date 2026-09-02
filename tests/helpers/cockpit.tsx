import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { App } from "../../src/client/components/App.js";
import type { PlanStep } from "../../src/daemon/plan.js";
import type { Total } from "../../src/daemon/ledger.js";
import type { Decision, RosterRow, ThreadEntry } from "../../src/shared/types.js";
import { REMOTE_OFF, type RemoteState } from "../../src/shared/remote.js";
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
  /** Make the thread read fail: "reject" for a dead link, a status number for
   * a daemon that answered badly. Both used to render as an empty thread. */
  threadFails?: "reject" | number;
  /** House rules already on the daemon when the page opens. */
  settings?: { codingStyle: string; workflowRules: string; reviewModel?: string };
  /** What GitHub says about the project the drawer is opened on. */
  github?: { slug: string | null; items: unknown[] };
  /** Where else this daemon answers. */
  addresses?: { origins: string[]; loopbackOnly: boolean };
  /** The Anthropic key the daemon is already holding, if any. */
  apiKey?: { present: boolean; hint: string; enabled?: boolean };
  /** What the daemon says when a key is offered to it. */
  keyReply?: { status: number; body: unknown };
  /** What the credential behind the bench has spent. Undefined is a daemon
   * with no oauth credential to ask, which is the ordinary case. */
  usage?: unknown;
  /** What the OpenRouter key has spent. Undefined is a daemon holding no
   * OpenRouter key, which is the ordinary case. */
  credit?: unknown;
  /**
   * What the ledger says, per project and for the bench as a whole.
   *
   * A function rather than a value because the one thing worth testing here
   * is that the two scopes differ: it is handed the `project` query the
   * cockpit asked with, or undefined for the whole-bench total. Undefined is
   * a bench that has never billed a turn, which is the ordinary case in a
   * test and must read as "nothing yet" rather than as a broken daemon.
   *
   * "unreachable" is the daemon refusing to answer, which the meter has to
   * say out loud rather than draw as zero.
   */
  spend?: ((project?: string) => unknown) | Total | "unreachable";
  /** The OpenRouter key the daemon is already holding, if any. */
  routerKey?: { present: boolean; hint: string };
  /** The catalogue the picker fills from. "unreachable" is OpenRouter
   * refusing to answer, which the picker has to open through. */
  models?: Array<{
    id: string; name: string; vendor: string;
    contextLength: number | null;
    price: { fresh: number | null; cacheWrite: number | null; cacheRead: number | null; out: number | null };
  }> | "unreachable";
  /** The turn the picker prices every model against. Undefined is a daemon
   * that has recorded none, which is the ordinary case in a test. */
  turnShape?: { shape: unknown; turns: number };
  /** The daemon's Google identity. Undefined is remote never having been
   * turned on, which is the ordinary case in a test. */
  remote?: RemoteState;
  /** What the daemon says when the cockpit asks it to connect or rename. */
  remoteReply?: { status: number; body: unknown };
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
  /** A pointer arriving on something, and leaving it again. React listens for
   * the "enter" pair, which do not bubble - they are dispatched on the
   * element itself, the way a real pointer delivers them. */
  hover: (element: Element | null | undefined) => Promise<void>;
  unhover: (element: Element | null | undefined) => Promise<void>;
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
  startedAt: null, tokens: 0, context: null, activity: [],
  answeredBy: null, createdBy: null, pendingPrompt: null, ...over,
});

export const entry = (over: Partial<ThreadEntry> = {}): ThreadEntry => ({
  seq: 1, at: new Date().toISOString(), kind: "user", body: "do the thing", ...over,
});

/** jsdom reflects `open` but implements neither method the dialog needs. */
function polyfillDialogs(): void {
  const proto = (globalThis as any).HTMLDialogElement?.prototype;
  if (!proto || proto.showModal) return;

  proto.showModal = function showModal(this: HTMLDialogElement) {
    // As the spec has it, and not a detail: showModal() on a dialog that is
    // already showing throws, so a component that reopens itself on every
    // roster push takes the page down with it. A polyfill that quietly
    // re-set the attribute made that bug invisible here.
    if (this.hasAttribute("open")) {
      throw new DOMException("dialog is already open", "InvalidStateError");
    }
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
      if (method === "POST" && url.includes("/enabled")) {
        const on = JSON.parse(String(init?.body)).enabled === true;
        const held = fixtures.apiKey ?? { present: false, hint: "" };
        return { ok: true, status: 200, json: async () => ({ ...held, enabled: on, verified: true }) };
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
      return { ok: true, status: 200, json: async () => ({ enabled: true, ...held, verified: true }) };
    }

    // What the picker asks for when it opens: whether a key is held, and the
    // catalogue it would reach. Above the POST branch because the key route
    // takes one too.
    if (url.includes("/api/openrouter/key")) {
      const method = init?.method ?? "GET";
      if (method !== "GET") sent.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null });
      const held = fixtures.routerKey ?? { present: false, hint: "" };
      return { ok: true, status: 200, json: async () => ({ ...held, verified: true }) };
    }

    // Its own branch above the rest, the same reason the key has one: three
    // verbs on one path, and what comes back from connecting or renaming is
    // what Settings shows next.
    if (url.includes("/api/remote")) {
      const method = init?.method ?? "GET";
      if (method === "GET") return { ok: true, status: 200, json: async () => fixtures.remote ?? REMOTE_OFF };
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      sent.push({ url, body });
      if (method === "DELETE") return { ok: true, status: 200, json: async () => REMOTE_OFF };

      const reply = fixtures.remoteReply;
      if (reply) return { ok: reply.status < 400, status: reply.status, json: async () => reply.body };

      if (url.endsWith("/api/remote/machine")) {
        return {
          ok: true, status: 200,
          json: async () => ({ ...(fixtures.remote ?? REMOTE_OFF), connected: true, machineName: body.name }),
        };
      }
      // /api/remote/identity: simulates the daemon accepting whatever the
      // popup handed the cockpit.
      return {
        ok: true, status: 200,
        json: async () => ({
          ...REMOTE_OFF, connected: true, uid: body.uid, email: body.email ?? null,
          machineId: "m1", machineName: "this-machine", tokenExpiresAt: Date.now() + 3_600_000,
        }),
      };
    }

    if (url.includes("/api/turn-shape")) {
      const shape = fixtures.turnShape ?? { shape: null, turns: 0 };
      return { ok: true, status: 200, json: async () => shape };
    }

    if (url.includes("/api/openrouter/models")) {
      const models = fixtures.models;
      return {
        ok: models !== "unreachable",
        status: models === "unreachable" ? 502 : 200,
        json: async () => (models === "unreachable"
          ? { error: "OpenRouter answered 500 for its model list" }
          : { models: models ?? [] }),
      };
    }

    if (init?.method === "POST") {
      sent.push({ url, body: JSON.parse(String(init.body)) });
      // Creating a specialist answers with its id, and the cockpit acts on it.
      const created = url.endsWith("/api/sessions") ? { id: fixtures.createdId ?? "s-new" } : {};
      return { ok: true, status: 200, json: async () => ({ ok: true, ...created }) };
    }
    if (url.includes("/thread")) {
      // A read that never lands, which on a relayed session is what several
      // reads an hour actually do. "reject" is a dead link; a number is a
      // daemon that answered with a status.
      if (fixtures.threadFails === "reject") throw new TypeError("fetch failed");
      if (typeof fixtures.threadFails === "number") {
        return { ok: false, status: fixtures.threadFails, json: async () => ({}) };
      }
      return { ok: true, status: 200, json: async () => ({ entries: fixtures.entries ?? [] }) };
    }
    if (url.includes("/report/")) {
      return {
        ok: fixtures.decision != null,
        status: fixtures.decision != null ? 200 : 404,
        json: async () => ({ seq: 1, decision: fixtures.decision, malformed: false }),
      };
    }
    // Above the other money routes because it is asked with the project in
    // the query string, and a project path that happened to contain one of
    // their names would otherwise be answered by the wrong branch.
    if (url.includes("/api/spend")) {
      const asked = new URL(url, "http://localhost").searchParams.get("project");
      const held = fixtures.spend;
      if (held === "unreachable") {
        return { ok: false, status: 500, json: async () => ({ error: "no ledger" }) };
      }
      const body = typeof held === "function"
        ? held(asked ?? undefined)
        : held ?? { plan: 0, account: 0, turns: 0, estimated: 0 };
      return { ok: true, status: 200, json: async () => body };
    }
    if (url.includes("/api/openrouter/usage")) {
      return {
        ok: true,
        status: 200,
        json: async () => fixtures.credit ?? { available: false, reason: "none" },
      };
    }
    if (url.includes("/api/usage")) {
      return {
        ok: true,
        status: 200,
        json: async () => fixtures.usage ?? { available: false, reason: "none" },
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
    hover: async (element) => {
      if (!element) throw new Error("nothing to hover");
      await act(async () => {
        element.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
        element.dispatchEvent(new MouseEvent("mouseenter"));
      });
      await settle();
    },
    unhover: async (element) => {
      if (!element) throw new Error("nothing to leave");
      await act(async () => {
        element.dispatchEvent(new MouseEvent("mouseout", { bubbles: true }));
        element.dispatchEvent(new MouseEvent("mouseleave"));
      });
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
