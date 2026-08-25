import { useEffect, useState } from "react";
import { authFetch, postJson } from "../api.js";

interface Held { present: boolean; hint: string; verified: boolean }

const NONE: Held = { present: false, hint: "", verified: true };

/**
 * The developer's own Anthropic key, for a bench that should bill somewhere
 * other than the login the machine already has.
 *
 * It saves on its own button rather than with the house rules. Everything on
 * the rules page is read back into the page each time it opens, and a secret
 * that comes back down is a secret anyone with the cockpit open can read - so
 * this one goes up and never returns. What comes back is which key it was.
 */
export function AnthropicKey({ open }: { open: boolean }) {
  const [held, setHeld] = useState<Held>(NONE);
  const [typed, setTyped] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setError("");
    setTyped("");
    let live = true;
    void (async () => {
      const res = await authFetch("/api/anthropic-key");
      if (!live || !res.ok) return;
      setHeld(await res.json());
    })();
    return () => { live = false; };
  }, [open]);

  const save = async () => {
    setError("");
    setBusy(true);
    try {
      const res = await postJson("/api/anthropic-key", { key: typed.trim() });
      const body = await res.json();
      if (!res.ok) { setError(body.error ?? "Could not keep that key."); return; }
      setHeld(body);
      // Typed once and gone. Leaving it in the box is leaving it on a screen.
      setTyped("");
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setError("");
    setBusy(true);
    try {
      const res = await authFetch("/api/anthropic-key", { method: "DELETE" });
      if (!res.ok) { setError("Could not let go of that key."); return; }
      setHeld(await res.json());
    } finally {
      setBusy(false);
    }
  };

  return (
    <section id="s-key">
      <label htmlFor="s-key-input">Anthropic API key or setup token</label>

      <p className="field-note" id="s-key-state">{describe(held)}</p>

      <input
        id="s-key-input"
        type="password"
        autoComplete="off"
        spellCheck={false}
        placeholder="sk-ant-…"
        value={typed}
        onChange={(event) => setTyped(event.target.value)}
      />

      <div className="s-key-buttons">
        <button type="button" id="s-key-save" disabled={busy || typed.trim() === ""} onClick={() => void save()}>
          {held.present ? "Replace key" : "Save key"}
        </button>
        {held.present && (
          <button type="button" id="s-key-remove" disabled={busy} onClick={() => void remove()}>Remove</button>
        )}
      </div>

      {error && <p id="s-key-error" className="error">{error}</p>}

      <p className="field-note" id="s-key-note">
        Optional. Either a console API key, which bills the API, or a token
        from <code>claude setup-token</code>, which bills the subscription it
        was minted from. Whichever is here takes precedence over this
        machine's claude.ai login. It is held in memory only — a daemon
        restart forgets it — and it reaches specialists started after it, not
        the ones already running.
      </p>
    </section>
  );
}

/** What may be said about a key that is now the daemon's. */
function describe(held: Held): string {
  if (!held.present) return "None set. Specialists use this machine's Claude login.";
  return held.verified
    ? `Using the key ending ${held.hint}, which the API answered for.`
    : `Using the key ending ${held.hint}. I could not reach the API to check it, ` +
      `so the first specialist to use it is the test.`;
}
