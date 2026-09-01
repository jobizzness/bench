import { useState } from "react";
import { useRemote } from "./useRemote.js";
import type { RemoteState } from "../../shared/remote.js";

/**
 * "Turn on remote" - the one control this ticket adds to Settings.
 *
 * Nothing here moves a command or a byte of a thread; signing in only gives
 * the daemon a Google identity to hold. What is reachable from another
 * device is #46's, one broadcast specialist at a time - see the design doc.
 */
export function Remote({ open }: { open: boolean }) {
  const { state, busy, error, connect, disconnect, rename } = useRemote(open);
  const [name, setName] = useState("");
  const [editingName, setEditingName] = useState(false);

  const startRename = () => {
    setName(state.machineName ?? "");
    setEditingName(true);
  };

  const saveRename = async () => {
    setEditingName(false);
    if (name.trim() === "" || name.trim() === state.machineName) return;
    await rename(name.trim());
  };

  return (
    <section id="s-remote">
      <label htmlFor="s-remote-toggle">Remote</label>

      <p className="field-note" id="s-remote-state">{describe(state)}</p>

      {state.connected && (
        <p className="field-note" id="s-remote-machine">
          This machine is{" "}
          {editingName
            ? (
              <input
                id="s-remote-machine-name"
                autoFocus
                value={name}
                disabled={busy}
                onChange={(event) => setName(event.target.value)}
                onBlur={() => void saveRename()}
                onKeyDown={(event) => {
                  if (event.key === "Enter") { event.preventDefault(); void saveRename(); }
                  if (event.key === "Escape") setEditingName(false);
                }}
              />
            )
            : (
              <button type="button" id="s-remote-rename" className="link" disabled={busy} onClick={startRename}>
                {state.machineName ?? "this machine"}
              </button>
            )}
        </p>
      )}

      <div className="s-remote-buttons">
        {state.connected
          ? (
            <button type="button" id="s-remote-off" disabled={busy} onClick={() => void disconnect()}>
              Turn off remote
            </button>
          )
          : (
            <button type="button" id="s-remote-on" disabled={busy} onClick={() => void connect()}>
              Turn on remote
            </button>
          )}
      </div>

      {error && <p id="s-remote-error" className="error">{error}</p>}

      <p className="field-note" id="s-remote-note">
        Signs this daemon in with your Google account so it can be reached
        from other devices signed into the same one. Nothing is shared with
        anyone else, and nothing leaves this machine until a specialist is
        broadcast.
      </p>
    </section>
  );
}

/** What may be said about the daemon's Google identity, in one line. */
function describe(state: RemoteState): string {
  if (state.error) return state.error;
  if (!state.connected) return "Off. Specialists stay on this machine.";
  const who = state.email ?? state.uid ?? "your account";
  const expiry = state.tokenExpiresAt
    ? ` Signed in until ${new Date(state.tokenExpiresAt).toLocaleTimeString()}, refreshed automatically.`
    : "";
  return `Signed in as ${who}.${expiry}`;
}
