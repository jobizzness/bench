/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import { StageLabel } from "../src/client/components/StageLabel.js";

let root: Root | null = null;
let posted: Array<{ path: string; label: string }> = [];
let reply = { ok: true, body: {} as unknown };

beforeEach(() => {
  posted = [];
  reply = { ok: true, body: {} };
  vi.stubGlobal("fetch", async (path: string, init: RequestInit) => {
    posted.push({ path, label: JSON.parse(String(init.body)).label });
    return { ok: reply.ok, status: reply.ok ? 200 : 400, json: async () => reply.body } as Response;
  });
});

afterEach(() => { act(() => root?.unmount()); root = null; vi.unstubAllGlobals(); });

function render(label: string): HTMLElement {
  const host = document.createElement("div");
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host);
    root.render(<StageLabel sessionId="s1" label={label} />);
  });
  return host;
}

const name = (host: HTMLElement) => host.querySelector<HTMLButtonElement>("#stage-label");
const field = (host: HTMLElement) => host.querySelector<HTMLInputElement>("#stage-label-input");

function open(host: HTMLElement): HTMLInputElement {
  act(() => { name(host)!.click(); });
  return field(host)!;
}

function type(input: HTMLInputElement, text: string): void {
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setter.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function press(input: HTMLInputElement, key: string): void {
  act(() => { input.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true })); });
}

describe("renaming from the header", () => {
  it("shows the name, and a field when you click it", () => {
    const host = render("auth");
    expect(name(host)!.textContent).toBe("auth");

    const input = open(host);
    expect(input.value).toBe("auth");
    // The commonest rename replaces the guess outright.
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe(4);
  });

  it("saves on Enter", async () => {
    const host = render("auth");
    type(open(host), "  session cookies on Safari  ");
    press(field(host)!, "Enter");
    await act(async () => {});

    expect(posted).toEqual([{ path: "/api/sessions/s1/label", label: "session cookies on Safari" }]);
    expect(field(host)).toBeNull();
  });

  it("saves once, not twice, when Enter also blurs the field", async () => {
    const host = render("auth");
    type(open(host), "billing");
    press(field(host)!, "Enter");
    await act(async () => {});
    expect(posted).toHaveLength(1);
  });

  it("keeps the old name on Escape", async () => {
    const host = render("auth");
    type(open(host), "billing");
    press(field(host)!, "Escape");
    await act(async () => {});

    expect(posted).toEqual([]);
    expect(name(host)!.textContent).toBe("auth");
  });

  it("saves when you click away", async () => {
    const host = render("auth");
    const input = open(host);
    type(input, "billing");
    act(() => { input.dispatchEvent(new FocusEvent("focusout", { bubbles: true })); });
    await act(async () => {});
    expect(posted.map((p) => p.label)).toEqual(["billing"]);
  });

  it("asks for nothing when the name has not changed", async () => {
    const host = render("auth");
    press(open(host), "Enter");
    await act(async () => {});
    expect(posted).toEqual([]);
  });

  it("asks for nothing when the name has been emptied", async () => {
    const host = render("auth");
    type(open(host), "   ");
    press(field(host)!, "Enter");
    await act(async () => {});
    expect(posted).toEqual([]);
  });

  it("says so when the daemon refuses", async () => {
    reply = { ok: false, body: { error: "that label is empty or too long to name anything" } };
    const host = render("auth");
    type(open(host), "billing");
    press(field(host)!, "Enter");
    await act(async () => {});

    expect(name(host)!.dataset.failed).toBe("true");
    expect(name(host)!.title).toContain("too long");
  });
});
