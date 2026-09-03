import { useEffect, useRef, useState } from "react";
import { postJson } from "../api.js";
import { answersFor } from "../../shared/decisions.js";
import { projectName } from "../format.js";
import { DecisionOptions } from "./DecisionOptions.js";
import { isIntake } from "./DecisionPanel.js";
import type { Waiting } from "./useQueue.js";

/**
 * Everything waiting on you, in one place, answered without going to find it.
 *
 * Six specialists working at once are only as fast as the queue in front of
 * one person, and until now that queue was navigation: open a tab, read,
 * answer, go back, open the next. This is the same answers with the walking
 * taken out.
 *
 * A questionnaire is not answered here. It is a page of its own with a brief
 * that rewrites itself as you go, and rushing one in a queue is how a default
 * nobody read gets sent - so those hand you over to the specialist instead.
 */
export function Queue({ items, open, onClose, onOpenSpecialist }: {
  items: Waiting[];
  open: boolean;
  onClose: () => void;
  /** For the ones that want the whole stage rather than a line in a list. */
  onOpenSpecialist: (id: string) => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [at, setAt] = useState(0);
  const [choice, setChoice] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [sent, setSent] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open) { if (!dialog.open) dialog.showModal?.(); }
    else if (dialog.open) dialog.close?.();
  }, [open]);

  // A fresh queue starts at the top with nothing typed into it.
  useEffect(() => {
    if (!open) return;
    setAt(0);
    setSent(new Set());
    setChoice(null);
    setText("");
    setError(null);
  }, [open]);

  // What is left, in the order the roster had them. Answered ones drop out
  // here rather than waiting for the daemon to say so, or the queue would
  // sit on a decision you just sent.
  const left = items.filter((item) => !sent.has(item.row.id));
  const current = left[Math.min(at, Math.max(0, left.length - 1))] ?? null;

  const send = async () => {
    if (!current || busy) return;
    if (!choice && text.trim() === "") return;

    setBusy(true);
    setError(null);
    try {
      const res = await postJson(`/api/sessions/${current.row.id}/answer`, {
        optionId: choice,
        text: text.trim(),
      });
      if (!res.ok) throw new Error(`answer failed: ${res.status}`);
      setSent((current$) => new Set(current$).add(current.row.id));
      setChoice(null);
      setText("");
      // Staying at the same index lands on whatever moved up into this slot.
      setAt((index) => Math.min(index, Math.max(0, left.length - 2)));
    } catch {
      // choice and text are untouched above, so the retry this invites does
      // not ask the developer to type the answer again (#60).
      setError("Didn't send. Check the connection and try again.");
    } finally {
      setBusy(false);
    }
  };

  const pick = (index: number) => { setAt(index); setChoice(null); setText(""); setError(null); };

  // Read it, press one key - the same bargain the decision bar makes. A queue
  // you have to click through is a list.
  // The same list the buttons draw, or the numbers under them would mean
  // something different from what they say.
  const options = current?.decision ? answersFor(current.decision) : [];
  useEffect(() => {
    if (!open) return;

    const onKey = (event: KeyboardEvent) => {
      // Every field in here owns its own keys, Enter included.
      const target = event.target;
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return;

      const number = Number(event.key) - 1;
      if (Number.isInteger(number) && number >= 0 && number < options.length) {
        event.preventDefault();
        setChoice(options[number].id);
        return;
      }
      if (event.key === "Enter") { event.preventDefault(); void send(); }
    };

    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
    // No dependency array: the handler closes over the current decision and
    // what has been chosen, and a stale closure here is a key that quietly
    // answers the wrong thing.
  });

  return (
    <dialog
      id="queue"
      className="sheet"
      ref={ref}
      onClose={onClose}
      onClick={(event) => { if (event.target === ref.current) onClose(); }}
    >
      <header id="queue-head">
        <strong>Waiting on you</strong>
        <span id="queue-count">{left.length}</span>
        <button type="button" id="queue-close" aria-label="Close" onClick={onClose}>×</button>
      </header>

      {left.length === 0 && (
        <p className="queue-note">
          Nothing is waiting. Every specialist is either working or has been answered.
        </p>
      )}

      {left.length > 0 && (
        <>
          <ol id="queue-list">
            {left.map((item, index) => (
              <li key={item.row.id}>
                <button
                  type="button"
                  className="queue-item"
                  aria-current={item === current}
                  onClick={() => pick(index)}
                >
                  <span className="queue-where">
                    {projectName(item.row.project)} · {item.row.label}
                  </span>
                  <span className="queue-title">
                    {item.decision?.title ?? "A report that could not be read"}
                  </span>
                </button>
              </li>
            ))}
          </ol>

          {current && <Current
            item={current}
            choice={choice}
            setChoice={setChoice}
            text={text}
            setText={setText}
            busy={busy}
            error={error}
            onSend={() => void send()}
            onOpen={() => { onOpenSpecialist(current.row.id); onClose(); }}
          />}
        </>
      )}
    </dialog>
  );
}

/** The one you are answering. */
function Current({ item, choice, setChoice, text, setText, busy, error, onSend, onOpen }: {
  item: Waiting;
  choice: string | null;
  setChoice: (id: string) => void;
  text: string;
  setText: (value: string) => void;
  busy: boolean;
  /** The last send for this item failed. What was typed is still in `text`
   * and `choice` - nothing here re-sends on its own (#60). */
  error: string | null;
  onSend: () => void;
  onOpen: () => void;
}) {
  const { decision } = item;
  const handOver = decision === null || isIntake(decision);

  return (
    <section id="queue-current">
      <span className="eyebrow">{projectName(item.row.project)} · {item.row.label}</span>
      <strong id="queue-current-title">{decision?.title ?? "A report that could not be read"}</strong>
      {decision && <p id="queue-current-summary">{decision.summary}</p>}

      {handOver
        ? (
          <div id="queue-handover">
            <p className="queue-note">
              {decision === null
                ? "Its report did not parse, so there is nothing to answer here."
                : "A questionnaire, with a brief that rewrites itself as you answer. It wants the whole page."}
            </p>
            <button type="button" id="queue-open" onClick={onOpen}>Open it</button>
          </div>
        )
        : (
          <>
            <DecisionOptions
              id="queue-options"
              decision={decision}
              choice={choice}
              onChoose={setChoice}
            />
            {error && <p id="queue-error" role="alert">{error}</p>}
            <div id="queue-send">
              <input
                id="queue-text"
                autoComplete="off"
                placeholder={answersFor(decision).length > 0 ? "Or say it in your own words" : "Your answer"}
                value={text}
                onChange={(event) => setText(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key !== "Enter") return;
                  event.preventDefault();
                  onSend();
                }}
              />
              <button
                type="button"
                id="queue-answer"
                disabled={busy || (!choice && text.trim() === "")}
                onClick={onSend}
              >
                Answer
              </button>
            </div>
            {answersFor(decision).length > 0 && (
              <p id="queue-hint">
                <kbd>1</kbd>–<kbd>{answersFor(decision).length}</kbd>{" pick  "}
                <kbd>↵</kbd>{" send"}
              </p>
            )}
          </>
        )}
    </section>
  );
}
