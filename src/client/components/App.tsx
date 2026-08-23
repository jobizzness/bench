import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { postJson } from "../api.js";
import { intakePayload, pickOption, sendBar } from "../intake.js";
import type { ArtifactRef } from "./ArtifactCard.js";
import { ArtifactDialog } from "./ArtifactDialog.js";
import { Composer } from "./Composer.js";
import { DecisionPanel, isIntake } from "./DecisionPanel.js";
import { IntakeCard } from "./IntakeCard.js";
import { IntakeSheet } from "./IntakeSheet.js";
import { Mark } from "./Mark.js";
import { NewSessionDialog } from "./NewSessionDialog.js";
import { Progress } from "./Progress.js";
import { Roster } from "./Roster.js";
import { SettingsDialog } from "./SettingsDialog.js";
import { StageHead } from "./StageHead.js";
import { StaleLink } from "./StaleLink.js";
import { Thread } from "./Thread.js";
import { Working } from "./Working.js";
import { BenchProvider } from "./context.js";
import { useCloseSpecialist } from "./useCloseSpecialist.js";
import { useDecision } from "./useDecision.js";
import { useDecisionKeys } from "./useDecisionKeys.js";
import { useRoster } from "./useRoster.js";
import { useSelection } from "./useSelection.js";
import { threadSignature, useThread } from "./useThread.js";
import { isWaiting } from "../waiting.js";

/**
 * The whole cockpit. It owns the four things every screen reads — who exists,
 * who is selected, what they have said, and what they are waiting on — and
 * nothing else. Everything below is given what it needs and decides only how
 * to draw it.
 */
export function App() {
  const rows = useRoster();
  const { selectedId, select } = useSelection();
  const row = rows.find((r) => r.id === selectedId) ?? null;

  const { entries, reload } = useThread(selectedId, threadSignature(row));
  const decisionState = useDecision(row);
  const { decision, answers, setAnswers, choice, setChoice, focus, setFocus, dismiss } = decisionState;

  const [text, setText] = useState("");
  // The intake's own box, kept apart from the composer's: one is an answer,
  // the other is a message, and they are sent to different places.
  const [note, setNote] = useState("");
  const [sheetOpen, setSheetOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [artifact, setArtifact] = useState<ArtifactRef | null>(null);
  const [creating, setCreating] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const input = useRef<HTMLTextAreaElement>(null);
  const note$ = useRef<HTMLTextAreaElement>(null);

  // Closing the one you were reading leaves the stage pointing at nothing.
  const closeSpecialist = useCloseSpecialist(
    useCallback((id: string) => { if (id === selectedId) select(null); }, [selectedId, select]),
  );
  const state = useMemo(() => ({ rows, selectedId }), [rows, selectedId]);
  const actions = useMemo(() => ({ select, closeSpecialist }), [select, closeSpecialist]);

  const intake = isIntake(decision);
  const bar = decision && intake ? sendBar(decision, answers) : null;

  // A questionnaire that arrives while you are reading something else still
  // has to announce itself. Closing it leaves the card, not silence.
  useEffect(() => { if (intake) setSheetOpen(true); }, [decision, intake]);

  /** The sheet's send. Answers plus whatever was written under them. */
  async function answerIntake() {
    if (!row || !decision || !bar || bar.blocked) return;
    setError(null);

    await postJson(`/api/sessions/${row.id}/answer`, {
      answers: intakePayload(decision, answers),
      text: note.trim(),
    });
    dismiss();
    setSheetOpen(false);
    setNote("");
    await reload();
  }

  async function submit() {
    if (!row) return;
    const said = text.trim();
    setError(null);

    // An intake is answered in its own sheet, so the composer beneath it is
    // what it always was: a way to say something to the specialist.
    if (decision && !intake) {
      if (!choice && said === "") return;
      await postJson(`/api/sessions/${row.id}/answer`, { optionId: choice, text: said });
      dismiss();
    } else {
      if (said === "") return;
      const res = await postJson(`/api/sessions/${row.id}/message`, { text: said });
      if (!res.ok) {
        setError((await res.json()).error ?? "could not send");
        return;
      }
    }

    setText("");
    await reload();
  }

  useDecisionKeys({
    // With the sheet closed, 1-9 would be changing answers nobody can see.
    // The keys belong to whatever is actually in front of you.
    decision: intake && !sheetOpen ? null : decision,
    answers,
    focus,
    setFocus,
    pick: (questionId, optionId) => {
      const question = decision?.questions.find((q) => q.id === questionId);
      if (question) setAnswers(pickOption(answers, question, optionId));
    },
    choose: setChoice,
    // Enter means the same thing it always did; where it lands now depends on
    // which of the two is in front of you.
    submit: () => void (intake ? answerIntake() : submit()),
    typeInstead: () => (intake ? note$.current : input.current)?.focus(),
  });

  // A specialist that has never been prompted is waiting to be told what it
  // is for. That question used to be asked before it existed.
  const placeholder = decision && !intake
    ? "Or type an answer"
    : row && entries.length === 0
      ? "What should this specialist do?"
      : "Message this specialist";

  // While the intake is a sheet, the composer under it is an ordinary message
  // box and says so - the keys that drive the questionnaire are described in
  // the sheet, where the questions are.
  const hint = decision && !intake
    ? (decision.options.length > 0 ? "options" as const : "reply" as const)
    : row && (row.status === "working" || row.status === "provisioning")
      ? "working" as const
      : "none" as const;

  return (
    <BenchProvider state={state} actions={actions}>
      <StaleLink />

      <main id="app">
        <aside id="roster">
          <header>
            <h1><Mark /><span>Bench</span></h1>
            <div className="header-actions">
              {/* House rules are not per specialist, so they hang off the
                  roster rather than off whoever happens to be on the stage. */}
              <button
                id="open-settings"
                type="button"
                title="House rules — how you want work done"
                onClick={() => setSettingsOpen(true)}
              >
                Rules
              </button>
              <button id="new-session" type="button" onClick={() => setCreating(true)}>New</button>
            </div>
          </header>
          <ul id="roster-list"><Roster /></ul>
        </aside>

        <section id="stage">
          <StageHead />
          {/* Where it has got to comes before what was said about it: the
              checklist is the answer to the question you opened this for. */}
          {/* An intake no longer competes for this room, so only a decision
              still drawn in the footer hides the checklist. */}
          <Progress decisionShowing={row !== null && isWaiting(row) && !intake} />
          <Thread
            entries={entries}
            sessionId={selectedId}
            hasRows={rows.length > 0}
            onOpen={setArtifact}
          />
          <Working />

          <footer id="composer">
            {/* An intake is a sheet; what stays down here is the door back to
                it. Everything smaller is still answered in place. */}
            {decision && intake && bar && (
              <IntakeCard decision={decision} send={bar} onOpen={() => setSheetOpen(true)} />
            )}
            {decision && !intake && (
              <DecisionPanel
                decision={decision}
                answers={answers}
                setAnswers={setAnswers}
                focus={focus}
                setFocus={setFocus}
                choice={choice}
                setChoice={setChoice}
              />
            )}
            <Composer
              text={text}
              setText={setText}
              onSubmit={() => void submit()}
              disabled={!row}
              placeholder={placeholder}
              hint={hint}
              optionCount={decision?.options.length ?? 0}
              send={null}
              inputRef={input}
              error={error}
            />
          </footer>
        </section>
      </main>

      <ArtifactDialog open={artifact} sessionId={selectedId} onClose={() => setArtifact(null)} />
      {decision && intake && bar && (
        <IntakeSheet
          open={sheetOpen}
          decision={decision}
          answers={answers}
          setAnswers={setAnswers}
          focus={focus}
          setFocus={setFocus}
          note={note}
          setNote={setNote}
          noteRef={note$}
          send={bar}
          onSend={() => void answerIntake()}
          onClose={() => setSheetOpen(false)}
        />
      )}
      <NewSessionDialog open={creating} onClose={() => setCreating(false)} />
      <SettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </BenchProvider>
  );
}
