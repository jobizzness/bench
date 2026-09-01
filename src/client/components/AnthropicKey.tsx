import { useEffect, useState } from "react";
import { authFetch, postJson } from "../api.js";
import { KeyToggle } from "./KeyToggle.js";

interface Held {
  present: boolean;
  hint: string;
  verified: boolean;
  enabled: boolean;
  /** Where the key came from, already in words: "typed here", or the variable
   * and file it was read out of. Empty when there is no key. */
  origin: string;
}

const NONE: Held = { present: false, hint: "", verified: true, enabled: true, origin: "" };

/**
 * What the daemon said, as a state this component can draw.
 *
 * Only an explicit false parks a key. A reply that says nothing about it is
 * an older daemon or a route with no opinion, and defaulting those to "off"
 * would show a working key as switched off - the one reading that would send
 * a developer looking for a fault that is not there.
 */
function asHeld(body: Partial<Held> | null | undefined): Held {
  return {
    present: body?.present === true,
    hint: body?.hint ?? "",
    verified: body?.verified !== false,
    enabled: body?.enabled !== false,
    origin: body?.origin ?? "",
  };
}

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
      setHeld(asHeld(await res.json()));
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
      setHeld(asHeld(body));
      // Typed once and gone. Leaving it in the box is leaving it on a screen.
      setTyped("");
    } finally {
      setBusy(false);
    }
  };

  /** Park it, or take it out of the car park. The key does not go up with
   * this: the daemon already has it, and asking for it again would mean a
   * developer cannot switch back on a key they no longer have to hand. */
  const park = async (enabled: boolean) => {
    setError("");
    setBusy(true);
    try {
      const res = await postJson("/api/anthropic-key/enabled", { enabled });
      if (!res.ok) { setError("Could not change which login is used."); return; }
      setHeld(asHeld(await res.json()));
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
      setHeld(asHeld(await res.json()));
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

      {held.present && (
        <KeyToggle enabled={held.enabled} busy={busy} onChange={(on) => void park(on)} />
      )}

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
        machine's claude.ai login. A key typed here is held in memory only —
        a daemon restart forgets it — and it reaches specialists started
        after it, not the ones already running.
        {" "}
        Bench also reads <code>ANTHROPIC_API_KEY</code> or{" "}
        <code>CLAUDE_CODE_OAUTH_TOKEN</code> from its environment or a{" "}
        <code>.env</code>, and one found that way comes back on every
        restart — switched off, since finding a key is not you choosing to
        spend it. Flip the switch above to start using it. Typing one here
        replaces it until the daemon stops, and is live the moment you save
        it. The switch is remembered either way — the answer you leave it on
        stays across a restart, so nothing changes what is billed without you
        saying so.
      </p>
    </section>
  );
}

/** What may be said about a key that is now the daemon's. */
function describe(held: Held): string {
  if (!held.present) return "None set. Specialists use this machine's Claude login.";

  // Named, because a key can now arrive without anyone typing it. The last
  // four characters say which key only to someone who already knows; where it
  // came from is what lets them go and change it.
  const which = `the key ending ${held.hint}${held.origin === "" ? "" : `, ${held.origin}`}`;

  // Parked is neither of the other two states: the key is known good and is
  // deliberately not being spent, and saying which login is being spent
  // instead is the whole reason to look at this line.
  if (!held.enabled) {
    return `Holding ${which}, switched off. Specialists use this machine's Claude login.`;
  }
  return held.verified
    ? `Using ${which}. The API answered for it.`
    : `Using ${which}. I could not reach the API to check it, ` +
      `so the first specialist to use it is the test.`;
}
