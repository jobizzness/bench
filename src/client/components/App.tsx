import { useCallback, useMemo, useRef, useState } from "react";
import { postJson } from "../api.js";
import { intakePayload, pickOption, sendBar } from "../intake.js";
import type { ArtifactRef } from "./ArtifactCard.js";
import { ArtifactDialog } from "./ArtifactDialog.js";
import { Composer } from "./Composer.js";
import { DecisionPanel, isIntake } from "./DecisionPanel.js";
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
  const [error, setError] = useState<string | null>(null);
  const [artifact, setArtifact] = useState<ArtifactRef | null>(null);
  const [creating, setCreating] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const input = useRef<HTMLTextAreaElement>(null);

  // Closing the one you were reading leaves the stage pointing at nothing.
  const closeSpecialist = useCloseSpecialist(
    useCallback((id: string) => { if (id === selectedId) select(null); }, [selectedId, select]),
  );
  const state = useMemo(() => ({ rows, selectedId }), [rows, selectedId]);
  const actions = useMemo(() => ({ select, closeSpecialist }), [select, closeSpecialist]);

  const intake = isIntake(decision);
  const bar = decision && intake ? sendBar(decision, answers) : null;

  async function submit() {
    if (!row) return;
    const said = text.trim();
    setError(null);

    if (decision && intake) {
      if (bar?.blocked) return;
      await postJson(`/api/sessions/${row.id}/answer`, {
        answers: intakePayload(decision, answers),
        text: said,
      });
      dismiss();
    } else if (decision) {
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
    decision,
    answers,
    focus,
    setFocus,
    pick: (questionId, optionId) => {
      const question = decision?.questions.find((q) => q.id === questionId);
      if (question) setAnswers(pickOption(answers, question, optionId));
    },
    choose: setChoice,
    submit: () => void submit(),
    typeInstead: () => input.current?.focus(),
  });

  // A specialist that has never been prompted is waiting to be told what it
  // is for. That question used to be asked before it existed.
  const placeholder = decision
    ? (intake ? "Anything else it should know" : "Or type an answer")
    : row && entries.length === 0
      ? "What should this specialist do?"
      : "Message this specialist";

  const hint = decision
    ? (intake ? "intake" as const
      : decision.options.length > 0 ? "options" as const : "reply" as const)
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
          <Progress />
          <Thread
            entries={entries}
            sessionId={selectedId}
            hasRows={rows.length > 0}
            onOpen={setArtifact}
          />
          <Working />

          <footer id="composer">
            {decision && (
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
              send={bar}
              inputRef={input}
              error={error}
            />
          </footer>
        </section>
      </main>

      <ArtifactDialog open={artifact} sessionId={selectedId} onClose={() => setArtifact(null)} />
      <NewSessionDialog open={creating} onClose={() => setCreating(false)} />
      <SettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </BenchProvider>
  );
}
