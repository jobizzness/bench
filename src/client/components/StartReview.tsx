import { useState } from "react";
import { postJson } from "../api.js";

/**
 * A second pair of eyes on this specialist's work, from the report that
 * claims it is finished.
 *
 * Every Verified list in this cockpit is written by the agent that did the
 * work. A reviewer opened here shares nothing with it but the repository -
 * its own worktree, its own conversation, and a brief that tells it to
 * disagree rather than to summarise.
 */
export function StartReview({ sessionId, seq, onOpened }: {
  sessionId: string;
  /** The report being reviewed, so the reviewer can read what was claimed. */
  seq: number;
  onOpened: (id: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const start = async () => {
    setBusy(true);
    setError("");
    try {
      const res = await postJson(`/api/sessions/${sessionId}/review`, { seq });
      if (!res.ok) {
        setError((await res.json()).error ?? "could not open a reviewer");
        return;
      }
      const { id } = await res.json();
      if (id) onOpened(String(id));
    } finally {
      setBusy(false);
    }
  };

  return (
    <button
      type="button"
      id="start-review"
      disabled={busy}
      title={error || "Open a reviewer on this branch, told to argue with it"}
      data-failed={error !== ""}
      onClick={() => void start()}
    >
      {busy ? "Opening…" : error ? "Would not open" : "Review this"}
    </button>
  );
}
