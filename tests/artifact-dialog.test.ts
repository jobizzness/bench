/**
 * @vitest-environment jsdom
 * @vitest-environment-options { "url": "http://localhost/?token=t%2Bok" }
 */
import { describe, it, expect, beforeAll } from "vitest";
import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

/** A report is a page: clicking it opens one, rather than unfolding it. */

const CLIENT = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "client");

const ROW = {
  id: "s1", label: "reset", project: "/var/www/demo",
  status: "done", detail: "ready", latestReportSeq: null, startedAt: null, tokens: 0,
};

const ENTRIES = [
  { seq: 1, at: new Date().toISOString(), kind: "user", body: "add password reset" },
  { seq: 2, at: new Date().toISOString(), kind: "report", body: "Token expiry strategy", reportSeq: 4 },
  { seq: 3, at: new Date().toISOString(), kind: "reply", body: "Where the mailer lives", replySeq: 5 },
];

let socket: any;
const $ = <T extends Element>(s: string) => document.querySelector<T>(s)!;
const $$ = (s: string) => [...document.querySelectorAll(s)];
// A tick was enough while every screen rendered synchronously. React
// islands mount and flush across scheduler turns, so waits are given room.
const settle = () => new Promise((r) => setTimeout(r, 10));

const dialog = () => $<HTMLDialogElement>("#artifact-dialog");
const cards = () => $$("#thread .card") as HTMLElement[];

beforeAll(async () => {
  const html = await readFile(join(CLIENT, "index.html"), "utf8");
  document.body.innerHTML = html.replace(/<script[\s\S]*?<\/script>/g, "");

  // jsdom reflects `open` but implements neither showModal nor close, so the
  // two behaviours this code depends on are stood in per the spec: showModal
  // opens it, close closes it and fires `close`. Browsers do the rest -
  // backdrop, focus trap, Esc - and that part is not what these assert.
  const dlg = $<HTMLDialogElement>("#artifact-dialog") as any;
  dlg.showModal ??= () => dlg.setAttribute("open", "");
  dlg.close ??= () => {
    if (!dlg.hasAttribute("open")) return;
    dlg.removeAttribute("open");
    dlg.dispatchEvent(new Event("close"));
  };

  globalThis.WebSocket = class { onmessage: any = null; onclose: any = null;
    constructor() { socket = this; } send() {} close() {} } as any;

  (globalThis as any).fetch = async (url: string) => {
    if (url.includes("/thread")) return { ok: true, json: async () => ({ entries: ENTRIES }) };
    return { ok: true, json: async () => ({}) };
  };

  // main mounts the React islands as well as running the vanilla cockpit.
  await import("../src/client/main.tsx");
  await settle();
  socket.onmessage({ data: JSON.stringify({ type: "roster", rows: [ROW] }) });
  await settle();
  $<HTMLElement>("#roster-list .row").click();
  await settle();
  await settle();
});

describe("artifact cards in the thread", () => {
  it("gives a report a door and no inline frame", () => {
    const [report] = cards();
    expect(report.querySelector(".kind")!.textContent).toBe("report");
    expect(report.querySelector(".title")!.textContent).toBe("Token expiry strategy");
    expect(report.querySelector("button.card-open")).not.toBeNull();
    expect(report.querySelector("iframe")).toBeNull();
  });

  it("still previews a reply, because a reply is the answer to something you asked", () => {
    const reply = cards()[1];
    expect(reply.querySelector(".kind")!.textContent).toBe("answer");
    expect(reply.querySelector("iframe")!.getAttribute("src")).toBe("/r/s1/5/reply.html?token=t%2Bok");
  });

  it("starts with the dialog closed and nothing loaded in it", () => {
    expect(dialog().open).toBe(false);
    expect($("#artifact-frame").hasAttribute("src")).toBe(false);
  });
});

describe("opening one", () => {
  it("opens the report in the dialog with its own title", () => {
    cards()[0].querySelector<HTMLButtonElement>("button.card-open")!.click();
    expect(dialog().open).toBe(true);
    expect($("#artifact-kind").textContent).toBe("report");
    expect($("#artifact-title").textContent).toBe("Token expiry strategy");
    expect($("#artifact-frame").getAttribute("src")).toBe("/r/s1/4/report.html?token=t%2Bok");
  });

  it("offers the same page in a real tab", () => {
    // The token is url-encoded rather than pasted in raw, or a "+" in it
    // silently becomes a space and the tab 401s.
    expect($<HTMLAnchorElement>("#artifact-tab").getAttribute("href"))
      .toBe("/r/s1/4/report.html?token=t%2Bok");
    expect($<HTMLAnchorElement>("#artifact-tab").target).toBe("_blank");
  });

  it("tears the frame down on close so a hidden page stops rendering", () => {
    $<HTMLButtonElement>("#artifact-close").click();
    expect(dialog().open).toBe(false);
    expect($("#artifact-frame").hasAttribute("src")).toBe(false);
  });

  it("closes on the backdrop but not on a click inside the dialog", () => {
    cards()[0].querySelector<HTMLButtonElement>("button.card-open")!.click();
    expect(dialog().open).toBe(true);

    $("#artifact-title").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(dialog().open).toBe(true);

    dialog().dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(dialog().open).toBe(false);
  });

  it("clears the frame when Esc closes it, not only the button", () => {
    cards()[1].querySelector<HTMLButtonElement>("button.card-open")!.click();
    expect($("#artifact-frame").getAttribute("src")).toBe("/r/s1/5/reply.html?token=t%2Bok");

    // What Esc does natively: the dialog closes and fires `close`.
    dialog().close();
    expect($("#artifact-frame").hasAttribute("src")).toBe(false);
  });
});
