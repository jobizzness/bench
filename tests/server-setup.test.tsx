/**
 * @vitest-environment jsdom
 * @vitest-environment-options { "url": "https://bench-cockpit.web.app/" }
 */
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ServerSetup } from "../src/client/components/ServerSetup.js";

/**
 * The first thing a hosted cockpit shows.
 *
 * Installed from static hosting, the page knows every screen in Bench and
 * not one thing about which machine it belongs to. This is where it is told,
 * and the important part is that it checks before it remembers: an address
 * saved without being tried is a broken cockpit tomorrow with nothing on
 * screen to correct.
 */

let root: Root | null = null;
let host: HTMLElement | null = null;
let fetched: Array<{ url: string; token: string }> = [];

const $ = <T extends Element>(selector: string) => host!.querySelector<T>(selector);

function mount(onClose: (() => void) | null = null): void {
  host = document.createElement("div");
  document.body.appendChild(host);
  act(() => { root = createRoot(host!); root.render(<ServerSetup open onClose={onClose} />); });
}

const type = (value: string) =>
  act(() => {
    const field = $<HTMLInputElement>("#server-setup-link")!;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setter.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });

const connect = async () => {
  await act(async () => { $<HTMLButtonElement>("#server-setup-connect")!.click(); });
  await act(async () => { await Promise.resolve(); });
};

/** What the daemon says back, and a record of what was asked. */
function daemonSays(status: number, ok = status < 400): void {
  fetched = [];
  (globalThis as any).fetch = async (url: string, init: any) => {
    fetched.push({ url, token: init?.headers?.["x-bench-token"] ?? "" });
    if (status === 0) throw new TypeError("failed to fetch");
    return { ok, status };
  };
}

beforeEach(() => {
  localStorage.clear();
  // The real one navigates, which jsdom will not do.
  Object.defineProperty(window, "location", {
    value: { ...window.location, reload: vi.fn(), origin: "https://bench-cockpit.web.app" },
    configurable: true,
  });
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
});

describe("being told where Bench is running", () => {
  it("asks for the line the daemon printed, not for two fields", async () => {
    mount();
    expect($("#server-setup-link")!.getAttribute("placeholder")).toContain("?token=");
  });

  it("remembers an address that answered, and starts again there", async () => {
    daemonSays(200);
    mount();
    await type("http://192.168.1.20:7420/?token=abc123");
    await connect();

    expect(fetched).toEqual([{ url: "http://192.168.1.20:7420/api/addresses", token: "abc123" }]);
    expect(JSON.parse(localStorage.getItem("bench:endpoint")!)).toEqual({
      origin: "http://192.168.1.20:7420",
      token: "abc123",
    });
    expect(location.reload).toHaveBeenCalled();
  });

  it("refuses to remember an address that did not answer", async () => {
    // Saving it would mean opening to a dead cockpit tomorrow, with the
    // wrong address nowhere on screen.
    daemonSays(0);
    mount();
    await type("http://192.168.1.99:7420/?token=abc123");
    await connect();

    expect(localStorage.getItem("bench:endpoint")).toBeNull();
    expect($(".setup-error")!.textContent).toContain("192.168.1.99:7420");
    expect(location.reload).not.toHaveBeenCalled();
  });

  it("names a stale token as a stale token, not as a missing machine", async () => {
    daemonSays(401, false);
    mount();
    await type("http://192.168.1.20:7420/?token=old");
    await connect();

    expect($(".setup-error")!.textContent).toContain("would not take the token");
    expect(localStorage.getItem("bench:endpoint")).toBeNull();
  });

  it("says what a link is missing rather than asking the daemon about it", async () => {
    daemonSays(200);
    mount();
    await type("http://192.168.1.20:7420/");
    await connect();

    expect(fetched).toEqual([]);
    expect($(".setup-error")!.textContent).toContain("?token=");
  });

  it("offers no way out at first run, because there is nothing behind it", () => {
    mount(null);
    expect($(".setup-cancel")).toBeNull();
  });

  it("can be dismissed once the cockpit has a daemon to go back to", async () => {
    const onClose = vi.fn();
    mount(onClose);
    await act(async () => { $<HTMLButtonElement>(".setup-cancel")!.click(); });
    expect(onClose).toHaveBeenCalled();
  });
});
