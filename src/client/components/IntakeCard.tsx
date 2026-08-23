import type { Decision } from "../../shared/types.js";
import type { SendBar } from "../intake.js";

/**
 * What the composer holds while an intake is waiting: the thing you tap to
 * bring it back.
 *
 * A sheet you can close needs a door you cannot miss, or closing it once means
 * losing the questions. It says what is being asked and how much of it still
 * wants you, so it is worth reading even when you are not going to open it
 * yet.
 */
export function IntakeCard({
  decision, send, onOpen,
}: {
  decision: Decision;
  send: SendBar;
  onOpen: () => void;
}) {
  const total = decision.questions.length;
  const waiting = send.pending > 0
    ? `${send.pending} of ${total} still ${send.pending === 1 ? "needs" : "need"} you`
    : `${total} ${total === 1 ? "question" : "questions"}, all answered`;

  return (
    <button
      type="button"
      id="intake-card"
      data-waiting={send.pending > 0}
      onClick={onOpen}
    >
      <span className="eyebrow">before I build</span>
      <span id="intake-card-title">{decision.title}</span>
      <span id="intake-card-count">{waiting}</span>
    </button>
  );
}
