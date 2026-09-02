import { useState } from "react";
import { postJson } from "../api.js";
import { BroadcastMark } from "./BroadcastMark.js";

/**
 * The one control that lets a specialist leave this machine.
 *
 * Off by default, and strict: turning it on is the only thing that puts a
 * byte of this specialist - or the sub-agent tabs it opened - into Firestore,
 * and turning it off takes them out immediately. See "Broadcast decides what
 * may be mirrored at all" in
 * `docs/superpowers/specs/2026-08-31-bench-over-firestore-design.md`.
 *
 * There is deliberately no state held here beyond "is the request in
 * flight" - the roster socket carries the new value back once the daemon has
 * it, the same way every other per-specialist toggle in this cockpit works,
 * so this component never has to guess whether its own write landed.
 */
export function Broadcast({ sessionId, broadcast }: {
  sessionId: string;
  broadcast: boolean;
}) {
  const [busy, setBusy] = useState(false);

  const toggle = async () => {
    setBusy(true);
    try {
      await postJson(`/api/sessions/${sessionId}/broadcast`, { broadcast: !broadcast });
    } finally {
      setBusy(false);
    }
  };

  // A mark rather than a word, because its neighbour on this header is one
  // and a lone text button beside an icon reads as something bolted on. The
  // state it carries is worth a label a screen reader can say, though, so
  // that goes on `aria-label` rather than being left to the tooltip.
  const said = broadcast
    ? "Reachable from your other devices. Click to stop."
    : "Not reachable from anywhere but this machine. Click to broadcast it.";

  return (
    <button
      type="button"
      id="broadcast-toggle"
      className={broadcast ? "on" : undefined}
      aria-pressed={broadcast}
      aria-label={said}
      disabled={busy}
      title={said}
      onClick={() => void toggle()}
    >
      <BroadcastMark />
    </button>
  );
}
