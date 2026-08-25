import { useSyncExternalStore } from "react";
import { DEFAULT_THEME, isThemeId } from "../shared/themes.js";
import { recall, remember } from "./remembered.js";

/** Named once, because index.html reads the same key before this file runs. */
export const THEME_KEY = "theme";

/**
 * Which palette this browser draws the cockpit in.
 *
 * Kept in the browser rather than on the daemon, for the same reason hidden
 * projects are: it is a property of the screen in front of you, not of the
 * work. The laptop in a bright office and the phone in bed are looking at one
 * bench, and the right answer is different on each.
 *
 * The whole of applying a theme is one attribute on <html>. Every colour in
 * the stylesheet is a variable, the variables are filled by a `[data-theme]`
 * block, and so the switch is instant and total - no re-render, no component
 * that has to know it happened, nothing to reload.
 */
let theme = read();

function read(): string {
  const stored = recall<string>(THEME_KEY, DEFAULT_THEME);
  // A theme that was removed, or a hand-edited key. Falling back beats a
  // cockpit with no palette at all, which is unreadable rather than merely
  // not what was asked for.
  return isThemeId(stored) ? stored : DEFAULT_THEME;
}

const listeners = new Set<() => void>();

/**
 * The bit that actually changes the picture.
 *
 * The status-bar colour goes with it: an installed cockpit draws under the
 * phone's chrome, and a Paper cockpit in a black-green frame looks broken in
 * a way no CSS in here can reach.
 */
function paint(next: string): void {
  const root = document.documentElement;
  root.dataset.theme = next;

  const meta = document.querySelector('meta[name="theme-color"]');
  const bg = getComputedStyle(root).getPropertyValue("--bg").trim();
  if (meta && bg) meta.setAttribute("content", bg);
}

export function setTheme(next: string): void {
  if (!isThemeId(next) || next === theme) return;
  theme = next;
  remember(THEME_KEY, next);
  paint(next);
  for (const listener of listeners) listener();
}

export function currentTheme(): string {
  return theme;
}

export function useTheme(): string {
  return useSyncExternalStore(
    (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
    () => theme,
    () => theme,
  );
}

// index.html sets the attribute before the first paint so nobody sees the
// default flash past. This is the same answer arrived at again, for the tab
// that ran an older shell out of the service worker's cache, and for tests,
// which mount the cockpit into a document that never had a head script.
if (typeof document !== "undefined") paint(theme);
