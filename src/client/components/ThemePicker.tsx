import { THEMES } from "../../shared/themes.js";
import { setTheme, useTheme } from "../theme.js";

/**
 * What the cockpit looks like, chosen by looking at it.
 *
 * A dropdown of theme names would be the smaller control and the worse one:
 * the only question anyone is asking here is "what does that one look like",
 * and a word cannot answer it. So each choice is a chip drawn in its own
 * palette - its own background, its own borders, its own three status hues in
 * the order they mean things - and picking is recognising rather than reading.
 *
 * It takes effect on the click rather than on Save. The rest of this sheet
 * goes to the daemon and can fail on the way; a theme is already here, and a
 * preference you have to commit to before you can see it is a preference you
 * have to undo to change your mind.
 */
export function ThemePicker() {
  const current = useTheme();

  return (
    <section id="s-theme">
      <h3>Theme</h3>

      <div id="s-theme-list">
        {THEMES.map((theme) => (
          <button
            type="button"
            key={theme.id}
            className="s-theme"
            data-theme={theme.id}
            aria-pressed={theme.id === current}
            onClick={() => setTheme(theme.id)}
          >
            {/* The three hues the cockpit says everything with: wants you,
                in flight, broken. Decoration to a screen reader - the name
                beside them is the label. */}
            <span className="s-theme-hues" aria-hidden="true">
              <i className="hue-wants" /><i className="hue-busy" /><i className="hue-broken" />
            </span>
            <span className="s-theme-name">{theme.label}</span>
          </button>
        ))}
      </div>

      <p className="field-note" id="s-theme-note">
        {THEMES.find((theme) => theme.id === current)?.note}{" "}
        Applied as you click it, and remembered by this browser only — the same
        bench on another screen keeps its own.
      </p>
    </section>
  );
}
