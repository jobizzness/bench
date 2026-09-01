import { useState } from "react";
import { postJson } from "../api.js";

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

  return (
    <button
      type="button"
      id="broadcast-toggle"
      aria-pressed={broadcast}
      disabled={busy}
      title={broadcast
        ? "Reachable from your other devices. Click to stop."
        : "Not reachable from anywhere but this machine. Click to broadcast it."}
      onClick={() => void toggle()}
    >
      {broadcast ? "Broadcasting" : "Broadcast"}
    </button>
  );
}
