import { useEffect, useRef, type RefObject } from "react";
import type { Decision } from "../../shared/types.js";
import type { Answers, SendBar } from "../intake.js";
import { DecisionPanel } from "./DecisionPanel.js";

/**
 * The questionnaire, in a sheet of its own.
 *
 * It used to live in the composer footer, where it was capped at half the
 * viewport and the specialist's checklist had to be hidden to make room for
 * it. Neither was about the intake - both were about the footer.
 *
 * Closing it does not answer it and does not lose what you have picked: the
 * answers live above this, and the card in the composer brings it back.
 */
export function IntakeSheet({
  open, decision, answers, setAnswers, focus, setFocus, note, setNote, noteRef, send, onSend, onClose,
}: {
  open: boolean;
  decision: Decision;
  answers: Answers;
  setAnswers: (next: Answers) => void;
  focus: number;
  setFocus: (index: number) => void;
  /** Anything else it should know, sent alongside the answers. */
  note: string;
  setNote: (value: string) => void;
  /** So `/` reaches it, the way it reaches the composer. */
  noteRef: RefObject<HTMLTextAreaElement | null>;
  send: SendBar;
  onSend: () => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open) { if (!dialog.open) dialog.showModal?.(); }
    else if (dialog.open) dialog.close?.();
  }, [open]);

  return (
    // Escape fires `close` natively, which is the same door as the button.
    <dialog id="intake-dialog" className="sheet" ref={ref} onClose={onClose}>
      <form
        id="intake-form"
        onSubmit={(event) => { event.preventDefault(); onSend(); }}
      >
        <DecisionPanel
          decision={decision}
          answers={answers}
          setAnswers={setAnswers}
          focus={focus}
          setFocus={setFocus}
          choice={null}
          setChoice={() => {}}
        />

        <label htmlFor="intake-note">Anything else it should know</label>
        <textarea
          id="intake-note"
          rows={2}
          ref={noteRef}
          placeholder="Optional. Sent with your answers."
          value={note}
          onChange={(event) => setNote(event.target.value)}
        />

        <div className="actions">
          {/* Not "cancel": nothing is discarded, and saying so is the only
              thing that makes closing it feel safe. */}
          <button type="button" id="intake-later" onClick={onClose}>Close for now</button>
          <button type="submit" id="intake-send" disabled={send.blocked} data-pending={send.blocked}>
            {send.label}
          </button>
        </div>
      </form>
    </dialog>
  );
}
