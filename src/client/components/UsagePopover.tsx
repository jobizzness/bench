import { useState } from "react";
import { UsageMark } from "./UsageMark.js";
import { UsageBars } from "./UsageBars.js";
import { useUsage } from "./useUsage.js";
import { fullest, type Usage } from "../../shared/usage.js";

/**
 * What is left, a hover away from the end of the composer.
 *
 * A hover rather than a click because this is a glance, not a page: the
 * question it answers - is there room to start another specialist this
 * afternoon - is one you ask in passing and act on immediately. It sits by
 * the box you type into because that is where you ask it.
 *
 * It is absent entirely when the daemon has no oauth credential to ask. An
 * icon whose only answer is "unavailable" is an icon that has to be read
 * before it can be ignored.
 */
export function UsagePopover() {
  const { usage, refresh } = useUsage();
  const [open, setOpen] = useState(false);

  if (usage === null || (!usage.available && usage.reason === "none")) return null;

  const windows = usage.available ? usage.windows : [];
  // Colour cannot be the only thing saying it. Said on the button rather than
  // only inside the panel, so a pointer resting on it - or a screen reader
  // passing over it - gets the number without opening anything.
  const worst = fullest(windows);
  const said = worst === null
    ? "What this login has spent"
    : `${worst.label}: ${worst.percent}% spent`;

  return (
    <div
      className="usage"
      onMouseEnter={() => { setOpen(true); void refresh(); }}
      onMouseLeave={() => setOpen(false)}
      // Focus opens it too, so the panel is not mouse-only. Both live on the
      // wrapper rather than the button: the panel is inside it, and a pointer
      // moving down into the panel must not read as leaving.
      onFocus={() => { setOpen(true); void refresh(); }}
      onBlur={() => setOpen(false)}
    >
      <button id="open-usage" type="button" title={said} aria-label={said}>
        <UsageMark windows={windows} />
      </button>
      {open && (
        <div id="usage-panel" role="status">
          {usage.available ? <UsageBars windows={usage.windows} /> : <p className="usage-note">{trouble(usage)}</p>}
        </div>
      )}
    </div>
  );
}

/** Why there are no numbers, said as the thing to do about it. */
function trouble(usage: Extract<Usage, { available: false }>): string {
  return usage.reason === "refused"
    ? "That credential was turned away — it may have expired. Log in again, or save a fresh token."
    : "Could not reach the API just now.";
}
