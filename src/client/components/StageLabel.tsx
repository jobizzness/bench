import { useEffect, useRef, useState } from "react";
import { postJson } from "../api.js";
import { LABEL_MAX, labelIsUsable } from "../../shared/slug.js";

/**
 * The specialist's name, edited where you read it.
 *
 * A name is a guess made before the work started - "auth" turns out to be
 * "session cookies on Safari" three turns in - and the only place the old
 * guess is still visible is the header. So the header is where it changes:
 * click the name, type, Enter. No dialog, no settings page, no field labelled
 * Label.
 *
 * The branch does not follow. It was cut when the specialist was made and may
 * already be pushed; renaming a checked-out branch to keep a string in sync is
 * a real risk taken for a cosmetic gain. The line below shows the branch, so
 * the two drifting apart is something you can see rather than something that
 * happens behind you.
 */
export function StageLabel({ sessionId, label }: { sessionId: string; label: string }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(label);
  const [refused, setRefused] = useState("");
  const input = useRef<HTMLInputElement>(null);
  /** Escape leaves through blur like Enter does, and this is the difference. */
  const abandoned = useRef(false);

  // Selected rather than caret-at-the-end: the common rename replaces the
  // name outright, and a name is short enough that the rarer case is one
  // keystroke away.
  useEffect(() => {
    if (!editing) return;
    input.current?.focus();
    input.current?.select();
  }, [editing]);

  const open = () => {
    setDraft(label);
    setRefused("");
    abandoned.current = false;
    setEditing(true);
  };

  /**
   * Committing happens on blur alone - Enter and Escape blur the field rather
   * than saving directly - so that leaving by any route goes through one path
   * and cannot save twice.
   */
  const commit = async () => {
    const next = draft.trim();
    if (abandoned.current || next === label || !labelIsUsable(next)) {
      setEditing(false);
      return;
    }

    const res = await postJson(`/api/sessions/${sessionId}/label`, { label: next });
    setEditing(false);
    // The name on screen is the roster's, and the roster arrives over the
    // socket a moment later. Saying so is only needed when it will not.
    if (!res.ok) setRefused((await res.json()).error ?? "the daemon would not rename it");
  };

  if (editing) {
    return (
      <input
        id="stage-label-input"
        ref={input}
        className="stage-name"
        value={draft}
        maxLength={LABEL_MAX}
        aria-label="Name of this specialist"
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => void commit()}
        onKeyDown={(e) => {
          if (e.key === "Escape") abandoned.current = true;
          if (e.key === "Enter" || e.key === "Escape") e.currentTarget.blur();
        }}
      />
    );
  }

  return (
    <button
      id="stage-label"
      className="stage-name"
      type="button"
      data-failed={refused !== ""}
      title={refused || "Rename this specialist"}
      onClick={open}
    >
      {label}
    </button>
  );
}
