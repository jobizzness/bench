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
 * Only works where the iframe's document is actually reachable from here. A
 * relayed report rendered as `srcDoc` is - `sandbox="allow-same-origin"`
 * gives it the parent's origin - and a local one usually is too, since it is
 * served by the same daemon the page came from. Where it is not (a relayed
 * report opened by URL from a different origin) reading the height throws,
 * and the CSS fallback height in `styles.css` is what carries it instead.
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
