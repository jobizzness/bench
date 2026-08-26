/**
 * Whether the key the daemon is holding is the one being used.
 *
 * A switch rather than a second Remove button: the choice a developer makes
 * several times in an afternoon is which login the work bills to, and one
 * that costs a paste each way is one they stop using.
 */
export function KeyToggle({ enabled, busy, onChange }: {
  enabled: boolean;
  busy: boolean;
  onChange: (enabled: boolean) => void;
}) {
  return (
    <label className="s-key-switch" htmlFor="s-key-enabled">
      <input
        id="s-key-enabled"
        type="checkbox"
        checked={enabled}
        disabled={busy}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span>Use this key</span>
    </label>
  );
}
