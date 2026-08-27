import { useRef, useState } from "react";
import { postJson } from "../api.js";

/**
 * Drops a specialist's conversation, so its next prompt starts fresh.
 *
 * The fix for the thing the context dial warns about: a conversation near its
 * window starts dropping the beginning of itself, and a very long one can have
 * the specialist going in circles. Clearing is the one thing the developer can
 * do about either.
 *
 * Everything else stays - the worktree, the branch, the reports, the spend.
 * Only the memory goes. That is worth saying on the button, because "clear"
 * next to a context ring reads like it might be clearing something bigger.
 *
 * Asked for once, like Stop. A context a developer has decided to drop is not
 * a decision they want to be asked about twice.
 */
export function ClearContext({ id }: { id: string }) {
  const [clearing, setClearing] = useState(false);
  // `disabled` only takes effect after a render, so two fast clicks both read
  // the old state and send twice. The ref is checked in the same tick.
  const sent = useRef(false);

  return (
    <button
      id="stage-clear"
      type="button"
      className="badge badge-clear"
      disabled={clearing}
      title="Forget this conversation, keep the work. The next prompt starts fresh."
      onClick={async () => {
        if (sent.current) return;
        sent.current = true;
        setClearing(true);
        try {
          await postJson(`/api/sessions/${id}/clear`, {});
        } finally {
          sent.current = false;
          setClearing(false);
        }
      }}
    >
      {clearing ? "clearing" : "clear context"}
    </button>
  );
}
