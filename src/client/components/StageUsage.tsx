import { usageTone } from "../../shared/usage.js";
import { useUsage } from "./useUsage.js";

/** Below this, the header stays quiet - a developer only needs telling once
 * there is a real chance of running out mid-afternoon. */
const WORTH_SAYING = 60;

/**
 * The five-hour window, on the header itself, once it is worth interrupting
 * a developer over.
 *
 * The composer already answers this on a hover, but a hover is a question
 * you have to think to ask. The five-hour window is the one that actually
 * stops a specialist mid-afternoon without warning - the week gives days of
 * notice, this one gives none - so it is the one window worth saying without
 * being asked.
 */
export function StageUsage() {
  const { usage } = useUsage();
  if (usage === null || !usage.available) return null;

  const window = usage.windows.find((w) => w.key === "five_hour");
  if (window === undefined || window.percent < WORTH_SAYING) return null;

  const said = `5-hour usage: ${window.percent}% spent`;
  return (
    <span className="stage-usage" title={said} aria-label={said} data-tone={usageTone(window.percent)}>
      <span className="stage-usage-track">
        <span className="stage-usage-fill" style={{ width: `${window.percent}%` }} />
      </span>
      <span className="stage-usage-percent">{window.percent}%</span>
    </span>
  );
}
