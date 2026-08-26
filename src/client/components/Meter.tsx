import { useState, type ReactNode } from "react";

/**
 * A mark at the end of the composer, and what it says when you rest on it.
 *
 * A hover rather than a click because this is a glance, not a page: the
 * question it answers - is there room to start another specialist this
 * afternoon - is one you ask in passing and act on immediately. It sits by
 * the box you type into because that is where you ask it.
 *
 * The shell only. What is being metered is the caller's business, and there
 * is more than one answer now: an Anthropic subscription is windows that
 * refill, an OpenRouter key is money that does not. Only one is ever mounted
 * at a time - whichever account the selected specialist is billed to - so the
 * ids stay the one pair the stylesheet and the tests already know.
 */
export function Meter({ said, mark, onOpen, children }: {
  /** The whole answer in a sentence, for a pointer resting on the button and
   * for a screen reader passing over it. Colour and height cannot be the only
   * things carrying a number. */
  said: string;
  mark: ReactNode;
  /** Asked again as the panel opens, because you point at a meter to find
   * out whether the number moved. */
  onOpen: () => void;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);

  return (
    <div
      className="usage"
      onMouseEnter={() => { setOpen(true); onOpen(); }}
      onMouseLeave={() => setOpen(false)}
      // Focus opens it too, so the panel is not mouse-only. Both live on the
      // wrapper rather than the button: the panel is inside it, and a pointer
      // moving down into the panel must not read as leaving.
      onFocus={() => { setOpen(true); onOpen(); }}
      onBlur={() => setOpen(false)}
    >
      <button id="open-usage" type="button" title={said} aria-label={said}>
        {mark}
      </button>
      {open && <div id="usage-panel" role="status">{children}</div>}
    </div>
  );
}
