import { useCallback, useEffect, useState } from "react";
import { pathForSession, sessionFromPath } from "../route.js";

/**
 * Which specialist is on the stage, kept in the URL.
 *
 * A specialist is a place: a tab per specialist, a reload that lands back
 * where you were, and a back button that means what it looks like it means.
 * The id is read straight from the path rather than waiting for the roster,
 * so the thread starts loading before the socket has said anything.
 */
export function useSelection(): {
  selectedId: string | null;
  /** null deselects — what closing the specialist you were reading does. */
  select: (id: string | null) => void;
} {
  const [selectedId, setSelectedId] = useState<string | null>(
    () => sessionFromPath(location.pathname),
  );

  useEffect(() => {
    const onPop = () => setSelectedId(sessionFromPath(location.pathname));
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const select = useCallback((id: string | null) => {
    setSelectedId(id);
    if (sessionFromPath(location.pathname) !== id) {
      history.pushState({ id }, "", pathForSession(id, location.search));
    }
  }, []);

  return { selectedId, select };
}
