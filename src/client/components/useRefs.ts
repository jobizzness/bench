import { useEffect, useState } from "react";
import type { ThreadEntry } from "../../shared/types.js";
import { authFetch } from "../api.js";
import { referencedNumbers, type Reference, type References } from "../markdown.js";

const NONE: References = new Map();

/**
 * What the numbers in a thread are about.
 *
 * Asked for by number rather than resolved as the text is rendered: a thread
 * re-renders on every roster tick, and the daemon holds the cache. Keyed on
 * the numbers themselves so scrolling, ticking and re-rendering cost nothing -
 * only a mention that was not there before does.
 */
export function useRefs(sessionId: string | null, entries: ThreadEntry[]): References {
  const [refs, setRefs] = useState<References>(NONE);

  const numbers = [...new Set(entries.flatMap((entry) => referencedNumbers(entry.body)))].sort();
  const key = numbers.join(",");

  useEffect(() => {
    if (!sessionId || key === "") { setRefs(NONE); return; }

    let live = true;
    void (async () => {
      const res = await authFetch(`/api/sessions/${sessionId}/refs?n=${key}`);
      if (!live || !res.ok) return;
      const body = await res.json();
      // A number nobody could resolve is simply absent, and renders as the
      // text it always was.
      setRefs(new Map((body.refs ?? []).map((r: Reference) => [r.number, r])));
    })();

    return () => { live = false; };
  }, [sessionId, key]);

  return refs;
}
