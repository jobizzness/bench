import { useRef, useState } from "react";
import { postJson } from "../api.js";

/**
 * Ends the turn a specialist is in the middle of.
 *
 * Until this the only way out of a turn going nowhere was to close the
 * specialist, which takes its worktree with it. Stopping takes the turn and
 * nothing else: the thread, the reports and the branch stay, and the next
 * prompt brings it back from the last turn it finished.
 *
 * Asked for once. A turn a developer has decided to end is not a decision
 * they want to be asked about twice, and the cost of a mistake is one turn.
 */
export function StopTurn({ id }: { id: string }) {
  const [stopping, setStopping] = useState(false);
  // `disabled` only takes effect after a render, so two fast clicks both read
  // the old state and send twice. The ref is checked in the same tick.
  const sent = useRef(false);

  return (
    <button
      id="stop-turn"
      type="button"
      disabled={stopping}
      title="End this turn. The specialist keeps its worktree and its memory."
      onClick={async () => {
        if (sent.current) return;
        sent.current = true;
        setStopping(true);
        try {
          await postJson(`/api/sessions/${id}/stop`, {});
        } finally {
          // The roster says what happened next; this only stops the button
          // being pressed twice while the process is going down.
          sent.current = false;
          setStopping(false);
        }
      }}
    >
      {stopping ? "Stopping" : "Stop"}
    </button>
  );
}
