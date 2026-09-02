import { useEffect, useState } from "react";

/** The same width `styles.css` switches on - kept as one literal here and
 * one literal there rather than shared, because the two are read by
 * completely different engines and a shared constant could not reach both. */
const QUERY = "(max-width: 720px)";

function matches(): boolean {
  // jsdom (this project's test environment) has no matchMedia at all -
  // every existing component test mounts <App /> and none of them are
  // exercising the phone build, so "not narrow" is the answer that leaves
  // them exactly as they were before this hook existed.
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return window.matchMedia(QUERY).matches;
}

/**
 * Whether the viewport is inside the phone breakpoint right now.
 *
 * Nothing in `styles.css` needs this - the stylesheet reacts to width on its
 * own. It exists for the handful of things that are not styling: whether
 * `usePhoneLanding.ts` is allowed to move `selectedId` on its own. Without
 * this gate that hook ran at every width, and a desktop session with
 * something waiting would find itself auto-opened onto a specialist nobody
 * asked for - the bug that broke `tests/queue.test.tsx` before this existed.
 */
export function useNarrowViewport(): boolean {
  const [narrow, setNarrow] = useState(matches);

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const query = window.matchMedia(QUERY);
    const onChange = () => setNarrow(query.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);

  return narrow;
}
