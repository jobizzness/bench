import { useEffect, useState } from "react";
import { disablePush, enablePush, pushState, type PushState } from "../push.js";

const NOTE: Record<PushState, string> = {
  on: "This device is told when a shared specialist finishes a turn, crashes, or is waiting for you to dispatch it - unless it already has that tab open.",
  off: "Get a notification here when a shared specialist needs you. Your machine has to be on, and the specialist shared to the web cockpit.",
  denied: "This browser has blocked notifications for Bench. Allow them in the browser's site settings, then switch this on.",
  unsupported: "This browser can't receive push notifications. On an iPhone, add Bench to the home screen first, then open it from there.",
  "signed-out": "Sign in to Bench first - notifications go to the account your machine is connected to.",
};

/** Device-local, like the theme: applied the moment it is switched, never
 * part of the daemon's settings - it is a fact about this browser. */
export function PushSwitch({ open }: { open: boolean }) {
  const [state, setState] = useState<PushState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => { if (open) void pushState().then(setState); }, [open]);

  if (state === null) return null;

  const toggle = async () => {
    setBusy(true);
    setError("");
    try {
      setState(state === "on" ? await disablePush() : await enablePush());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section id="s-push">
      <h3>Notifications</h3>
      <div className="check">
        <input
          type="checkbox" id="s-push-on"
          checked={state === "on"}
          disabled={busy || state === "unsupported" || state === "signed-out" || state === "denied"}
          onChange={() => { void toggle(); }}
        />
        <label htmlFor="s-push-on">Notify me on this device</label>
      </div>
      <p className="field-note" id="s-push-note">{NOTE[state]}</p>
      {error && <p className="error">Couldn't switch notifications: {error}</p>}
    </section>
  );
}
