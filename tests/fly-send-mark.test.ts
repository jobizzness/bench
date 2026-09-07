/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { launchSendMark, launchSendMarkBurst } from "../src/client/components/flySendMark.js";

/** jsdom lays nothing out, so every real element's `getBoundingClientRect()`
 * comes back all zeros - exactly the "phone button on a desktop Enter-send"
 * case this module has to survive. Stubbing the rect is how the "visible"
 * and "fallback" branches get exercised at all. */
function stubRect(el: Element, rect: Partial<DOMRect>): void {
  el.getBoundingClientRect = () => ({
    x: 0, y: 0, width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0,
    toJSON: () => ({}),
    ...rect,
  });
}

function planes(): NodeListOf<Element> {
  return document.querySelectorAll(".send-fly");
}

beforeEach(() => {
  document.body.innerHTML = `
    <button id="composer-send"></button>
    <textarea id="composer-text"></textarea>
  `;
});

afterEach(() => {
  document.body.innerHTML = "";
  // @ts-expect-error - test-only teardown of a property this suite defined.
  delete window.matchMedia;
});

describe("the plane a send launches", () => {
  it("does nothing when neither the button nor the field has a real rect", () => {
    launchSendMark();
    expect(planes().length).toBe(0);
  });

  it("launches from the button when it actually has a rect", () => {
    stubRect(document.getElementById("composer-send")!, { left: 100, top: 200, width: 40, height: 40 });

    launchSendMark();

    expect(planes().length).toBe(1);
  });

  it("falls back to the composer field when the button's rect is zero (desktop Enter-send)", () => {
    // The button exists in the DOM either way - `phone-only` hides it with
    // CSS, which is exactly what a zero rect looks like here.
    stubRect(document.getElementById("composer-text")!, { left: 10, top: 20, right: 300, width: 290, height: 30 });

    launchSendMark();

    expect(planes().length).toBe(1);
  });

  it("removes itself once its animation ends, leaving nothing behind", () => {
    stubRect(document.getElementById("composer-send")!, { left: 0, top: 0, width: 40, height: 40 });
    launchSendMark();
    const plane = planes()[0]!;

    plane.dispatchEvent(new Event("animationend"));

    expect(planes().length).toBe(0);
    expect(document.body.contains(plane)).toBe(false);
  });

  it("throws three, staggered, at a level-3 burst - same mechanism, not a second one", async () => {
    stubRect(document.getElementById("composer-send")!, { left: 0, top: 0, width: 40, height: 40 });

    launchSendMarkBurst();
    expect(planes().length).toBe(1);

    await new Promise((r) => setTimeout(r, 220));
    expect(planes().length).toBe(3);
  });

  it("launches nothing under prefers-reduced-motion", () => {
    stubRect(document.getElementById("composer-send")!, { left: 0, top: 0, width: 40, height: 40 });
    (window as unknown as { matchMedia: (q: string) => MediaQueryList }).matchMedia = ((query: string) => ({
      matches: query.includes("prefers-reduced-motion"),
      media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {},
      dispatchEvent: () => false, onchange: null,
    })) as unknown as typeof window.matchMedia;

    launchSendMark();

    expect(planes().length).toBe(0);
  });
});
