import { useEffect, useRef, useState } from "react";
import { pointAt } from "../api.js";
import { parseCockpitLink, reach, type Endpoint } from "../endpoint.js";

/**
 * Where Bench is running.
 *
 * A cockpit served by its own daemon never sees this: the address is the one
 * the page came from and the token is in the URL. A cockpit installed from
 * static hosting has neither, and this is the first thing it shows - once,
 * and then never again, because the answer is remembered.
 *
 * It asks for the link the daemon printed rather than for an address and a
 * token in two boxes. That line is one thing on the terminal and taking it
 * apart by hand is work the page can do.
 */
export function ServerSetup({ open, onClose }: { open: boolean; onClose: (() => void) | null }) {
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [trying, setTrying] = useState(false);
  const field = useRef<HTMLInputElement>(null);

  useEffect(() => { if (open) field.current?.focus(); }, [open]);

  if (!open) return null;

  async function connect(): Promise<void> {
    const endpoint: Endpoint | null = parseCockpitLink(text);
    if (!endpoint) {
      setError("That is not a cockpit link. It ends in ?token= followed by a long string.");
      return;
    }

    setTrying(true);
    setError(null);
    // Checked before it is saved. Remembering an address that does not answer
    // means opening to a broken cockpit tomorrow with nothing to correct.
    const found = await reach(endpoint);
    setTrying(false);

    if (found === "ok") { pointAt(endpoint); return; }
    setError(
      found === "unauthorized"
        ? "That daemon is there but would not take the token. Copy the link it printed most recently."
        : `Nothing answered at ${endpoint.origin}. Check Bench is running and that this device can reach it.`,
    );
  }

  return (
    <div id="server-setup" role="dialog" aria-modal="true" aria-labelledby="server-setup-title">
      <div className="setup-card">
        <h2 id="server-setup-title">Where is Bench running?</h2>
        <p>
          Paste the link Bench printed when it started. It carries both the
          address and the token.
        </p>

        <input
          ref={field}
          id="server-setup-link"
          type="url"
          spellCheck={false}
          autoComplete="off"
          placeholder="http://192.168.1.20:7420/?token=…"
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => { if (event.key === "Enter") void connect(); }}
        />

        {error && <p className="setup-error" role="alert">{error}</p>}

        <div className="setup-actions">
          {/* Only when there is something to go back to. At first run there
              is no cockpit behind this to cancel into. */}
          {onClose && (
            <button type="button" className="setup-cancel" onClick={onClose}>Cancel</button>
          )}
          <button type="button" id="server-setup-connect" disabled={trying} onClick={() => void connect()}>
            {trying ? "Looking…" : "Connect"}
          </button>
        </div>

        <p className="setup-note">
          A browser will not let an HTTPS page reach a plain HTTP address
          unless it is this same machine — so a phone needs Bench behind
          HTTPS, or the copy of the cockpit the daemon serves itself.
        </p>
      </div>
    </div>
  );
}
