import { useEffect, useRef, useState, type RefObject } from "react";
import { loadArtifact, type ArtifactContent } from "../api.js";

export interface ReportFrame {
  content: ArtifactContent | null;
  frameRef: RefObject<HTMLIFrameElement | null>;
  /** Wire to the iframe's `onLoad`. */
  onFrameLoad: () => void;
}

/**
 * The report inline, sized to its own content rather than to its own
 * scrollbar.
 *
 * A fixed-height iframe that scrolls itself splits one screen into two: the
 * report scrolls, then you hit its edge and the *page* still has to scroll
 * to reach what is under it. Reading the loaded document's own height and
 * setting it on the frame turns that back into one column - the same one
 * the decision's options are in (see `PhoneUnblock.tsx`).
 *
 * Only works where the iframe's document is actually reachable from here,
 * and on a phone that is not a rare exception - it is closer to a coin
 * flip. `loadArtifact` (`api.ts`) hands a local session's report over as a
 * `src` URL and a relayed one (mirrored from another machine, which is the
 * ordinary way a specialist reaches a phone at all) as `srcDoc` HTML;
 * `sandbox="allow-same-origin"` gives the `srcDoc` case the parent's
 * origin regardless of which machine actually rendered it, so that one
 * reads fine here. The `src` case is the one that can go either way - it is
 * only readable when the daemon happens to share an origin with the page,
 * which a hosted cockpit reaching a daemon directly over a LAN address does
 * not. Either kind can throw in practice, so the fixed-height fallback in
 * `styles.css` is not a degraded path to tolerate - it is a real screen a
 * phone shows often, sized and treated accordingly.
 */
export function useReportFrame(sessionId: string, seq: number): ReportFrame {
  const [content, setContent] = useState<ArtifactContent | null>(null);
  const frameRef = useRef<HTMLIFrameElement>(null);

  useEffect(() => {
    setContent(null);
    let live = true;
    void loadArtifact(sessionId, seq, "report.html").then((result) => { if (live) setContent(result); });
    return () => { live = false; };
  }, [sessionId, seq]);

  const onFrameLoad = () => {
    const frame = frameRef.current;
    if (!frame) return;
    try {
      const height = frame.contentDocument?.documentElement.scrollHeight;
      if (height) frame.style.height = `${height}px`;
    } catch {
      // Cross-origin: leave the CSS height in place and let the frame
      // scroll on its own rather than as part of the page.
    }
  };

  return { content, frameRef, onFrameLoad };
}
