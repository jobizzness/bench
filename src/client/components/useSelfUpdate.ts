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

  // `POST /api/update` answers as soon as the daemon has *started* the run,
  // not when it finishes (#150) - a build can take minutes, well past any
  // client timeout, and a timeout here is not a failed update. Whether one
  // is running, and how it came out, is read from `status.running`/
  // `status.runError` below instead - the same pushed status a second tab or
  // a phone sees, so all of them agree. A network failure on this request is
  // exactly what a slow update outliving the connection looks like from
  // here, not a reason to say anything.
  const update = useCallback(async () => {
    setError(null);
    try {
      const res = await postJson("/api/update", {}, { local: true });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}) as { error?: string });
        setError(body.error ?? "the update failed");
      }
    } catch {
      // Ignored - see the comment above.
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
    // The reason a run this button started was refused - dirty tree,
    // diverged branch, failed build - reaches here only through the pushed
    // status; the response to the tap that started it carried none of that.
    ?? status?.runError
    ?? (status?.fetchError ? `Could not check for updates: ${status.fetchError}` : null);

  if (action.kind === "update") {
    return { kind: "update", behind: action.behind, busy: status?.running ?? false, fieldNote, onTap: update };
  }
  if (action.kind === "restart") {
    return { kind: "restart", behind: 0, busy: restarting, fieldNote, onTap: restart };
  }
  return { kind: null, behind: 0, busy: false, fieldNote, onTap: () => {} };
}
