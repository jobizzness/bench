import { Meter } from "./Meter.js";
import { UsageMark } from "./UsageMark.js";
import { UsageBars } from "./UsageBars.js";
import { useUsage } from "./useUsage.js";
import { fullest, type Usage } from "../../shared/usage.js";

/**
 * What is left of the Anthropic subscription, a hover away from the end of
 * the composer.
 *
 * Mounted for a specialist that is billed to Anthropic. One that runs through
 * OpenRouter gets CreditPopover instead: its turn never touches these
 * windows, so reporting them beside its name would be answering about the
 * wrong account.
 *
 * Absent entirely when the daemon has no oauth credential to ask. A mark
 * whose only answer is "unavailable" is a mark that has to be read before it
 * can be ignored.
 */
export function UsagePopover() {
  const { usage, refresh } = useUsage();

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
    <Meter said={said} mark={<UsageMark windows={windows} />} onOpen={() => void refresh()}>
      {usage.available ? <UsageBars windows={usage.windows} /> : <p className="usage-note">{trouble(usage)}</p>}
    </Meter>
  );
}

/** Why there are no numbers, said as the thing to do about it. */
function trouble(usage: Extract<Usage, { available: false }>): string {
  return usage.reason === "refused"
    ? "That credential was turned away — it may have expired. Log in again, or save a fresh token."
    : "Could not reach Anthropic to ask. The credential is fine as far as anyone here knows.";
}
