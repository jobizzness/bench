import { usageTone, type UsageWindow } from "../../shared/usage.js";

/**
 * The windows, as bars.
 *
 * One row per window the daemon named — not per window this file knows
 * about, so a window Anthropic adds arrives without a release here. That is
 * also why the label is the daemon's: this component never has to be taught
 * what `seven_day_opus` is called.
 *
 * The number is printed beside every bar. A bar alone puts the whole reading
 * on a length and a hue, and hue is exactly what a colourblind developer or a
 * printed screenshot loses first.
 */
export function UsageBars({ windows }: { windows: UsageWindow[] }) {
  if (windows.length === 0) return <p className="usage-note">Nothing recorded against this login yet.</p>;

  return (
    <ul id="usage-list">
      {windows.map((window) => (
        <li className="usage-row" key={window.key} data-tone={usageTone(window.percent)}>
          <span className="usage-label">{window.label}</span>
          {/* Before the track in source, not after it: the track spans both
              columns, and anything following it is pushed onto a line of its
              own - which put the number under the bar instead of beside the
              label it belongs to. */}
          <span className="usage-percent">{window.percent}%</span>
          <span className="usage-track">
            <span className="usage-fill" style={{ width: `${window.percent}%` }} />
          </span>
          {window.resetsAt !== null && <span className="usage-reset">resets {resetLabel(window.resetsAt)}</span>}
        </li>
      ))}
    </ul>
  );
}

/**
 * When a window turns over, in as few characters as will still answer the
 * question being asked.
 *
 * "14:20" for one that turns over today, because the only question about a
 * five-hour window is whether it is worth waiting for. A weekday for anything
 * further out, because "09:00" alone would read as this morning.
 */
function resetLabel(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;

  const time = at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return at.toDateString() === new Date().toDateString()
    ? time
    : `${at.toLocaleDateString([], { weekday: "short" })} ${time}`;
}
