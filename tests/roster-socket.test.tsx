/**
 * @vitest-environment jsdom
 * @vitest-environment-options { "url": "http://localhost/?token=t" }
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useRoster } from "../src/client/components/useRoster.js";
import { STALE_EVENT } from "../src/client/api.js";
import { UNAUTHORIZED } from "../src/client/reconnect.js";
import { row } from "./helpers/cockpit.js";

/**
 * The socket the roster arrives on, and what it does when that socket goes.
 *
 * `shouldReconnect` has its own tests; what those cannot say is whether this
 * hook is wired to it. Retrying a refused socket forever is what turned a
 * stale link into "all my specialists are gone", so the difference between
 * the two branches is worth proving here rather than one level down.
 */

interface FakeSocket {
  onopen: (() => void) | null;
  onmessage: ((e: { data: string }) => void) | null;
  onclose: ((e: { code: number }) => void) | null;
  closed: boolean;
}

let sockets: FakeSocket[] = [];
let root: Root | null = null;
let host: HTMLElement | null = null;

function Probe() {
  const { rows, live } = useRoster();
  return (
    <>
      <div id="labels">{rows.map((r) => r.label).join(",")}</div>
      <div id="live">{String(live)}</div>
    </>
  );
}

function mount(): void {
  sockets = [];
  (globalThis as any).WebSocket = class {
    onopen = null;
    onmessage = null;
    onclose = null;
    closed = false;
    constructor() { sockets.push(this as unknown as FakeSocket); }
    send() {}
    close() { this.closed = true; }
  };

  host = document.createElement("div");
  document.body.appendChild(host);
  act(() => { root = createRoot(host!); root.render(<Probe />); });
}

/** Only the timer the retry uses; faking React's scheduling as well hangs it. */
const withFakeTimer = () => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  vi.useRealTimers();
});

const labels = () => host!.querySelector("#labels")!.textContent;
const live = () => host!.querySelector("#live")!.textContent;
const deliver = (socket: FakeSocket, ...rows: ReturnType<typeof row>[]) =>
  act(() => { socket.onmessage!({ data: JSON.stringify({ type: "roster", rows }) }); });

describe("the roster socket", () => {
  it("opens one socket and renders what it is sent", () => {
    mount();
    expect(sockets).toHaveLength(1);

    deliver(sockets[0], row({ id: "a", label: "auth" }), row({ id: "b", label: "billing" }));
    expect(labels()).toBe("auth,billing");
  });

  it("reconnects a dropped socket, and the new one feeds the same roster", () => {
    withFakeTimer();
    mount();

    // 1006 is what a killed daemon looks like from the page's side.
    act(() => { sockets[0].onclose!({ code: 1006 }); });
    expect(sockets).toHaveLength(1);

    act(() => { vi.advanceTimersByTime(1000); });
    expect(sockets).toHaveLength(2);

    deliver(sockets[1], row({ id: "a", label: "back" }));
    expect(labels()).toBe("back");
  });

  it("gives up on a refused socket and says the link is stale", () => {
    withFakeTimer();
    mount();

    let announced = 0;
    document.addEventListener(STALE_EVENT, () => { announced += 1; });

    act(() => { sockets[0].onclose!({ code: UNAUTHORIZED }); });
    act(() => { vi.advanceTimersByTime(5000); });

    // The token will not become valid by asking again.
    expect(sockets).toHaveLength(1);
    expect(announced).toBe(1);
  });

  it("keeps the roster it already had when the socket drops", () => {
    withFakeTimer();
    mount();
    deliver(sockets[0], row({ id: "a", label: "auth" }));

    act(() => { sockets[0].onclose!({ code: 1006 }); });
    // A specialist does not stop existing because the page lost its socket.
    expect(labels()).toBe("auth");
  });

  it("says nothing about the connection until the first socket has settled", () => {
    mount();
    // A page that is still connecting has no bad news to announce.
    expect(live()).toBe("null");
  });

  it("reports the connection up once the socket opens, and down when it drops", () => {
    withFakeTimer();
    mount();
    act(() => { sockets[0].onopen!(); });
    expect(live()).toBe("true");

    act(() => { sockets[0].onclose!({ code: 1006 }); });
    expect(live()).toBe("false");

    act(() => { vi.advanceTimersByTime(1000); });
    act(() => { sockets[1].onopen!(); });
    expect(live()).toBe("true");
  });

  it("leaves a refused socket to the stale banner rather than calling it offline", () => {
    // Both at once would describe the same silence twice, and only one of
    // them can be acted on.
    withFakeTimer();
    mount();
    act(() => { sockets[0].onclose!({ code: UNAUTHORIZED }); });
    expect(live()).toBe("null");
  });

  it("closes its socket on unmount and does not reconnect afterwards", () => {
    withFakeTimer();
    mount();

    act(() => { root!.unmount(); });
    expect(sockets[0].closed).toBe(true);

    // A close fired during teardown must not schedule a fresh connection.
    act(() => { sockets[0].onclose!({ code: 1006 }); });
    act(() => { vi.advanceTimersByTime(5000); });
    expect(sockets).toHaveLength(1);

    root = null;
  });
});
