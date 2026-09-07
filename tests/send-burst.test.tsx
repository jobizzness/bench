/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useSendBurst } from "../src/client/components/useSendBurst.js";

/**
 * `useSendBurst` is a hook, so it needs a component to live in - this one
 * does nothing but expose `level` as text and `record()` behind a button,
 * the same shape `tests/helpers/cockpit.tsx` uses for the real app.
 */
function Probe({ onRecord }: { onRecord: (fn: () => { level: number; justReachedMax: boolean }) => void }) {
  const { level, record } = useSendBurst();
  onRecord(record);
  return <div id="level">{level}</div>;
}

let host: HTMLElement;
let root: Root;
let record: () => { level: number; justReachedMax: boolean };

function mount(): void {
  host = document.createElement("div");
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host);
    root.render(<Probe onRecord={(fn) => { record = fn; }} />);
  });
}

const level = () => host.querySelector("#level")!.textContent;

beforeEach(() => {
  vi.useFakeTimers();
  mount();
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
});

describe("the burst level machine", () => {
  it("starts a fresh burst at 1", () => {
    act(() => { record(); });
    expect(level()).toBe("1");
  });

  it("escalates on a send that follows closely", () => {
    act(() => { record(); });
    act(() => { vi.advanceTimersByTime(1000); });
    act(() => { record(); });

    expect(level()).toBe("2");
  });

  it("caps at 3 rather than counting past it", () => {
    act(() => { record(); });
    act(() => { record(); });
    act(() => { record(); });
    act(() => { record(); });

    expect(level()).toBe("3");
  });

  it("reports justReachedMax only on the send that first hits 3", () => {
    let results: boolean[] = [];
    act(() => { results.push(record().justReachedMax); });
    act(() => { results.push(record().justReachedMax); });
    act(() => { results.push(record().justReachedMax); });
    act(() => { results.push(record().justReachedMax); });

    expect(results).toEqual([false, false, true, false]);
  });

  it("starts over at 1 after a gap longer than the window", () => {
    act(() => { record(); });
    act(() => { record(); });
    expect(level()).toBe("2");

    act(() => { vi.advanceTimersByTime(6001); });
    act(() => { record(); });

    expect(level()).toBe("1");
  });

  it("decays to 0 six seconds after the last send, not the first", () => {
    act(() => { record(); });
    act(() => { vi.advanceTimersByTime(5000); });
    act(() => { record(); });
    // 5.5s after the second send: past the window from the first, inside it
    // from the second - a decay keyed on the first would already have fired.
    act(() => { vi.advanceTimersByTime(5500); });

    expect(level()).toBe("2");

    act(() => { vi.advanceTimersByTime(600); });
    expect(level()).toBe("0");
  });
});
