import { useEffect, useState } from "react";
import { authFetch, postJson } from "../api.js";

interface Held { present: boolean; hint: string; verified: boolean }

const NONE: Held = { present: false, hint: "", verified: true };

function asHeld(body: Partial<Held> | null | undefined): Held {
  return {
    present: body?.present === true,
    hint: body?.hint ?? "",
    verified: body?.verified !== false,
  };
}

/**
 * The developer's OpenRouter key, which is what lets a specialist be run on
 * anybody other than Anthropic.
 *
 * One key for every other provider, rather than one per provider: OpenRouter
 * is the account, and Gemini or GPT or anything else on it are models that
 * account can reach. It saves on its own button and never comes back down,
 * the same as the Anthropic key above it.
 */
export function OpenRouterKey({ open }: { open: boolean }) {
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
      const res = await authFetch("/api/openrouter/key");
      if (!live || !res.ok) return;
      setHeld(asHeld(await res.json()));
    })();
    return () => { live = false; };
  }, [open]);

  const save = async () => {
    setError("");
    setBusy(true);
    try {
      const res = await postJson("/api/openrouter/key", { key: typed.trim() });
      const body = await res.json();
      if (!res.ok) { setError(body?.error ?? "Could not keep that key."); return; }
      setHeld(asHeld(body));
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
      const res = await authFetch("/api/openrouter/key", { method: "DELETE" });
      if (!res.ok) { setError("Could not let go of that key."); return; }
      setHeld(asHeld(await res.json()));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section id="s-router">
      <label htmlFor="s-router-input">OpenRouter API key</label>

      <p className="field-note" id="s-router-state">{describe(held)}</p>

      <input
        id="s-router-input"
        type="password"
        autoComplete="off"
        spellCheck={false}
        placeholder="sk-or-v1-…"
        value={typed}
        onChange={(event) => setTyped(event.target.value)}
      />

      <div className="s-key-buttons">
        <button type="button" id="s-router-save" disabled={busy || typed.trim() === ""} onClick={() => void save()}>
          {held.present ? "Replace key" : "Save key"}
        </button>
        {held.present && (
          <button type="button" id="s-router-remove" disabled={busy} onClick={() => void remove()}>Remove</button>
        )}
      </div>

      {error && <p id="s-router-error" className="error">{error}</p>}

      <p className="field-note" id="s-router-note">
        Optional, and only for specialists you run on something other than
        Claude — Gemini, GPT, and everything else{" "}
        <a href="https://openrouter.ai/models" target="_blank" rel="noreferrer">OpenRouter</a>{" "}
        carries. Those requests go through OpenRouter and are billed there, not
        to Anthropic. Held in memory only — a daemon restart forgets it — and
        it reaches specialists started after it, not the ones already running.
      </p>
    </section>
  );
}

function describe(held: Held): string {
  if (!held.present) return "None set. Only Anthropic's models are offered.";
  return held.verified
    ? `Using the key ending ${held.hint}, which OpenRouter answered for.`
    : `Using the key ending ${held.hint}. I could not reach OpenRouter to check it, ` +
      `so the first specialist to use it is the test.`;
}
