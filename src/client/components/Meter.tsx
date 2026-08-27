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
 * refill, an OpenRouter key is money that does not, and the ledger is money
 * that has already gone. The first two are still exclusive - only one account
 * is ever the one the selected specialist is billed to - and they keep the
 * `usage` pair of ids the stylesheet and the tests already know, which is why
 * the name is a prop with that default rather than a second copy of this
 * file. What is no longer true is that only one meter is mounted: the ledger
 * sits beside whichever of them is up, so it needs a pair of its own or the
 * page ends up with two elements answering to `#open-usage`.
 */
export function Meter({ said, mark, onOpen, children, id = "usage" }: {
  /** The whole answer in a sentence, for a pointer resting on the button and
   * for a screen reader passing over it. Colour and height cannot be the only
   * things carrying a number. */
  said: string;
  mark: ReactNode;
  /** Asked again as the panel opens, because you point at a meter to find
   * out whether the number moved. */
  onOpen: () => void;
  children: ReactNode;
  /** What this meter's button and panel are called, so two of them can be up
   * at once. Defaults to the pair that was here before there was a choice. */
  id?: string;
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
      <button id={`open-${id}`} type="button" title={said} aria-label={said}>
        {mark}
      </button>
      {open && <div id={`${id}-panel`} role="status">{children}</div>}
    </div>
  );
}
