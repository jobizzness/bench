import { useEffect, useState } from "react";
import type { Attachment } from "../../shared/types.js";
import type { References } from "../markdown.js";
import { Markdown } from "./Markdown.js";

/** A message this page sent and has not heard back about yet - kept here
 * rather than folded into `ThreadEntry`'s shape, because it carries the raw
 * attachment bytes the composer already had (`Attachment`), not the
 * by-reference kind a landed entry points at (`AttachmentRef`, resolved
 * through `/api/sessions/:id/image/:name` - a name this one does not have
 * yet). See `App.tsx`'s `submit()`. */
export interface PendingMessage {
  /** Local only - never sent, never a real `seq`. Just needs to be stable
   * for React's key and for finding this one again once it settles. */
  id: string;
  /** Which specialist this was said to - `App.tsx` keeps one flat list
   * across every specialist rather than one per row, so this is what keeps
   * a message sent to one from showing up in another's thread while it is
   * still in flight. */
  sessionId: string;
  text: string;
  images: Attachment[];
  at: string;
}

/**
 * A just-sent message, on screen before the POST behind it has answered.
 *
 * Arrives already resting where a real entry would sit - the animation is
 * the one frame between mounting and that resting state, not a property
 * that could replay. `useThread`'s reload swaps this for the real entry once
 * the daemon has it; nothing here is keyed off whether that has happened,
 * only off whether this component has been mounted before (#82's lesson:
 * `#app` hides whole subtrees with `display: none`, and a plain `animation:`
 * would play again every time this remounted into view - transitioning
 * between two states this component tracks itself never has that problem,
 * because a transition has nothing to play without an actual change, and
 * `arrived` only ever flips once).
 */
export function PendingEntry({ message, refs }: { message: PendingMessage; refs?: References }) {
  const [arrived, setArrived] = useState(false);

  useEffect(() => {
    const raf = requestAnimationFrame(() => setArrived(true));
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <div className={`entry user pending-entry${arrived ? " arrived" : ""}`}>
      <div className="who">you<span className="when">sending…</span></div>
      <Markdown className="bubble" text={message.text} refs={refs} />
      {message.images.length > 0 && (
        <div className="entry-attachments">
          {message.images.map((image, i) => (
            <div key={i} className="entry-attachment">
              <img src={`data:${image.mediaType};base64,${image.data}`} alt="Attachment" />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
