import type { Activity } from "../../daemon/activity.js";
import { ago } from "../format.js";

/**
 * What the specialist actually ran, folded away.
 *
 * Ten lines of `Bash cat package.json` in your face is noise; the one thing
 * worth having on screen is what it is doing right now and how long it has
 * been doing it. The rest is there when you ask, and the count says how much
 * you are choosing not to look at.
 */
export function Trail({ items }: { items: Activity[] }) {
  if (items.length === 0) return null;

  const [latest, ...earlier] = [...items].reverse();

  return (
    <details id="trail-fold">
      <summary>
        <span className="now">{latest.text}</span>
        <span className="when">{ago(latest.at)}</span>
        {earlier.length > 0 && <span className="more">{earlier.length} before it</span>}
      </summary>
      <ul id="trail">
        {/* The newest is already in the summary; repeating it reads as a bug. */}
        {earlier.map((item) => (
          <li className="trail-item" key={`${item.at}-${item.text}`}>
            <span>{item.text}</span>
            <span className="when">{ago(item.at)}</span>
          </li>
        ))}
      </ul>
    </details>
  );
}
