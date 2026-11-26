/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ThreadEntry as Entry } from "../src/shared/types.js";
import { ThreadEntry } from "../src/client/components/ThreadEntry.js";
import { senderOf } from "../src/shared/sender.js";

let root: Root | null = null;
let host: HTMLElement | null = null;
afterEach(() => { act(() => root?.unmount()); host?.remove(); root = null; host = null; });

function render(entry: Partial<Entry>): HTMLElement {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  const full = { seq: 1, at: new Date().toISOString(), kind: "user", body: "hi", ...entry } as Entry;
  act(() => root!.render(<ThreadEntry entry={full} sessionId="s" onOpen={() => {}} isNew={false} />));
  return host;
}
const who = (el: HTMLElement) => el.querySelector(".who-name")?.textContent;

describe("who a thread entry says it is from", () => {
  it("names the developer, a specialist and bench apart", () => {
    expect(who(render({ from: { kind: "developer" } }))).toBe("you");
    act(() => root?.unmount()); host?.remove();
    expect(who(render({ from: { kind: "specialist", id: "x", label: "cto" } }))).toBe("cto");
    act(() => root?.unmount()); host?.remove();
    expect(who(render({ from: { kind: "bench" } }))).toBe("bench");
  });

  it("gives a specialist its own colour, the same everywhere", () => {
    const a = render({ from: { kind: "specialist", id: "x", label: "cto" } }).querySelector<HTMLElement>(".entry")!;
    const colour = a.style.getPropertyValue("--who");
    expect(colour).toMatch(/^hsl\(/);
    act(() => root?.unmount()); host?.remove();
    const b = render({ from: { kind: "specialist", id: "other-id", label: "cto" } }).querySelector<HTMLElement>(".entry")!;
    expect(b.style.getPropertyValue("--who")).toBe(colour);
  });

  it("shows a sent line and a note with who they went to", () => {
    expect(who(render({ kind: "sent", to: { id: "i", label: "impl" } }))).toBe("→ impl");
    act(() => root?.unmount()); host?.remove();
    expect(who(render({ kind: "note", from: { kind: "developer" }, to: { id: "i", label: "impl" } }))).toBe("you → impl · note");
  });
});

describe("old entries, written before senders were recorded", () => {
  it("are read off the wording bench used, and are the developer otherwise", () => {
    expect(senderOf({ kind: "user", body: 'transactions wrote a report: "X". Read …' }))
      .toEqual({ kind: "specialist", id: "", label: "transactions" });
    expect(senderOf({ kind: "user", body: "From the CTO tab: both of your calls are right" }))
      .toMatchObject({ kind: "specialist", label: "CTO" });
    expect(senderOf({ kind: "user", body: "[bench] Context was cleared. Continue from where you left off." }))
      .toEqual({ kind: "bench" });
    expect(senderOf({ kind: "user", body: "filters look weird" })).toEqual({ kind: "developer" });
    expect(senderOf({ kind: "user", body: '[bench] decision: chose "recent"' })).toEqual({ kind: "developer" });
  });
});

describe("the newest reply", () => {
  it("is marked, so its themed background is the one that moves", () => {
    const el = render({ kind: "reply", body: "done" });
    expect(el.querySelector(".entry")!.classList.contains("entry-latest")).toBe(false);
    act(() => root?.unmount()); host?.remove();
    host = document.createElement("div"); document.body.append(host); root = createRoot(host);
    const full = { seq: 2, at: new Date().toISOString(), kind: "reply", body: "done" } as Entry;
    act(() => root!.render(<ThreadEntry entry={full} sessionId="s" onOpen={() => {}} isNew={false} latest />));
    expect(host.querySelector(".entry")!.classList.contains("entry-latest")).toBe(true);
  });
});

describe("copying a message", () => {
  it("copies exactly the message's text, and says so", async () => {
    const writes: string[] = [];
    Object.defineProperty(window, "isSecureContext", { value: true, configurable: true });
    Object.defineProperty(navigator, "clipboard", { value: { writeText: async (t: string) => { writes.push(t); } }, configurable: true });
    const el = render({ kind: "reply", body: "**Done.** Merged as `abc123`." });
    const button = el.querySelector<HTMLButtonElement>(".copy-message")!;
    expect(button.getAttribute("aria-label")).toBe("Copy message");
    await act(async () => { button.click(); await Promise.resolve(); });
    expect(writes).toEqual(["**Done.** Merged as `abc123`."]);
    expect(el.querySelector(".copy-message")!.getAttribute("aria-label")).toBe("Copied");
  });

  it("is on your messages too, and on nothing empty", () => {
    expect(render({ kind: "user", body: "make it blue", from: { kind: "developer" } }).querySelector(".copy-message")).not.toBeNull();
    act(() => root?.unmount()); host?.remove();
    expect(render({ kind: "user", body: "  " }).querySelector(".copy-message")).toBeNull();
  });
});
