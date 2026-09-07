/**
 * The send glyph flying out of the send button on every send (#103) -
 * `tap()`'s haptic is for the ear, this is for the eye. Sending is instant
 * now (#86), and instant had come to mean silent: the message appearing was
 * the only sign anything happened.
 *
 * Built by hand and appended straight to `document.body`, never as anything
 * React owns - it never becomes a class name toggled by state, and nothing
 * mounts or unmounts it. The only way this function ever runs is a real
 * send calling it, once (three times at a level-3 burst, staggered, but
 * still one call each) - so a re-render, a roster push, or `#stage` going
 * `display: none` and back on a pane swap (the exact mechanism #82 named)
 * cannot replay it, because none of those ever call it themselves. It
 * removes itself on its own `animationend`, so there is no cleanup effect
 * anywhere that has to remember it exists.
 *
 * Same glyph as `SendMark.tsx` (a copy of its markup, not an import of the
 * React component - there is no React tree to mount it into here), left
 * untouched itself per #103's own out-of-scope: the developer has claimed
 * the button's own animation for themselves.
 */
export function launchSendMark(): void {
  if (typeof document === "undefined" || typeof window === "undefined") return;
  // jsdom (this project's test environment) has no `matchMedia` at all - see
  // `useNarrowViewport.ts`'s own guard for the same thing.
  if (typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    return;
  }

  const origin = launchPoint();
  if (!origin) return;

  const size = 20;
  const plane = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  plane.setAttribute("viewBox", "0 0 24 24");
  plane.setAttribute("width", String(size));
  plane.setAttribute("height", String(size));
  plane.setAttribute("fill", "none");
  plane.setAttribute("stroke", "currentColor");
  plane.setAttribute("stroke-width", "1.8");
  plane.setAttribute("stroke-linecap", "round");
  plane.setAttribute("stroke-linejoin", "round");
  plane.setAttribute("aria-hidden", "true");
  plane.classList.add("send-fly");
  plane.innerHTML =
    '<line x1="21" y1="3" x2="10.5" y2="13.5" /><polygon points="21 3 14 21 10.5 13.5 3 10 21 3" />';
  plane.style.left = `${origin.x - size / 2}px`;
  plane.style.top = `${origin.y - size / 2}px`;

  plane.addEventListener("animationend", () => plane.remove(), { once: true });
  document.body.appendChild(plane);
}

/** Two extra planes at a level-3 burst, on short staggered delays - "throw
 * more", not "throw a different thing". `setTimeout` rather than anything
 * awaited: this is called from the same synchronous send handler `tap()`
 * is, and nothing in that block may await (#86). */
export function launchSendMarkBurst(): void {
  launchSendMark();
  setTimeout(launchSendMark, 90);
  setTimeout(launchSendMark, 180);
}

/**
 * Where the plane takes off from: the send button's own rect when it is
 * actually visible, else the trailing edge of the composer field. A desktop
 * Enter-send never touches the phone's send button, which CSS hides above
 * the breakpoint (`#composer-send.phone-only { display: none }`) - and a
 * `display: none` element's `getBoundingClientRect()` comes back all zeros,
 * which is the "zero rect" this exists to never launch from.
 */
function launchPoint(): { x: number; y: number } | null {
  const button = document.getElementById("composer-send");
  const buttonRect = button?.getBoundingClientRect();
  if (buttonRect && !(buttonRect.width === 0 && buttonRect.height === 0)) {
    return { x: buttonRect.left + buttonRect.width / 2, y: buttonRect.top + buttonRect.height / 2 };
  }

  const field = document.getElementById("composer-text");
  const fieldRect = field?.getBoundingClientRect();
  if (fieldRect && !(fieldRect.width === 0 && fieldRect.height === 0)) {
    return { x: fieldRect.right, y: fieldRect.top + fieldRect.height / 2 };
  }

  return null;
}
