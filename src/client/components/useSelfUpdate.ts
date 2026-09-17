import { useCallback, useEffect, useState } from "react";
import { postJson } from "../api.js";
import { blockedMessage, type SelfUpdateStatus } from "../../shared/self-update.js";
import type { RosterRow } from "../../shared/types.js";

export interface SelfUpdate {
  kind: "update" | "restart" | null;
  behind: number;
  busy: boolean;
  /** A refusal, or a watcher that could not fetch - shown as a `field-note`
   * beside `pinnedKeyNotice`. `null` when there is nothing to say. */
  fieldNote: string | null;
  onTap(): void;
}

/**
 * The update button's whole life, from the state the daemon pushes
 * alongside the roster (#146): what it says, whether it is waiting on
 * something, and what tapping it does. `App.tsx` owns none of this - it
 * only renders what comes back, the same split `useQueue`/`useHandoff`
 * already follow.
 *
 * Both routes pass `local: true` - this is a machine-global action and must
 * land on the daemon that served this page, never on whichever machine's
 * tab happens to be open (#139).
 */
export function useSelfUpdate(status: SelfUpdateStatus | null, rows: RosterRow[]): SelfUpdate {
  const [updating, setUpdating] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const action = status?.action ?? { kind: "none" as const };

  // The ground truth for "did the restart actually happen" is the next
  // status this daemon - or its successor - pushes, not the response to the
  // tap that asked for it. `askForRestart` returns long before the daemon
  // does.
  useEffect(() => {
    if (action.kind !== "restart") setRestarting(false);
  }, [action.kind]);

  const update = useCallback(async () => {
    setError(null);
    setUpdating(true);
    try {
      const res = await postJson("/api/update", {}, { local: true });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}) as { error?: string });
        setError(body.error ?? "the update failed");
      }
    } catch {
      setError("Could not reach the daemon to update.");
    } finally {
      setUpdating(false);
    }
  }, []);

  const restart = useCallback(async () => {
    const n = rows.length;
    if (!confirm(`This stops ${n} specialist${n === 1 ? "" : "s"} on this machine. Restart now?`)) return;
    setError(null);
    setRestarting(true);
    try {
      const res = await postJson("/api/update/restart", {}, { local: true });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}) as { error?: string });
        setError(body.error ?? "the restart failed");
        setRestarting(false);
      }
      // A success here means only that the request to restart landed - the
      // daemon itself may still be waiting out running turns. `restarting`
      // stays true until the effect above sees it come back changed.
    } catch {
      // The connection dying mid-response is what an already-begun restart
      // looks like from here, not a failure to report.
    }
  }, [rows.length]);

  const fieldNote = error
    ?? (action.kind === "blocked" ? blockedMessage(action.reason) : null)
    ?? (status?.fetchError ? `Could not check for updates: ${status.fetchError}` : null);

  if (action.kind === "update") {
    return { kind: "update", behind: action.behind, busy: updating, fieldNote, onTap: update };
  }
  if (action.kind === "restart") {
    return { kind: "restart", behind: 0, busy: restarting, fieldNote, onTap: restart };
  }
  return { kind: null, behind: 0, busy: false, fieldNote, onTap: () => {} };
}
