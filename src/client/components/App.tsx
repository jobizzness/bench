import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { endpoint, isRemote, postJson } from "../api.js";
import { shouldAskForServer } from "../endpoint.js";
import { answersFor } from "../../shared/decisions.js";
import { projectName } from "../format.js";
import { intakePayload, pickOption, sendBar } from "../intake.js";
import type { ArtifactRef } from "./ArtifactCard.js";
import { ArtifactDialog } from "./ArtifactDialog.js";
import { Composer } from "./Composer.js";
import { DecisionPanel, isIntake } from "./DecisionPanel.js";
import { Gear } from "./Gear.js";
import { GithubDrawer } from "./GithubDrawer.js";
import { IntakeCard } from "./IntakeCard.js";
import { IntakeSheet } from "./IntakeSheet.js";
import { BrainMark } from "./BrainMark.js";
import { Mark } from "./Mark.js";
import { Offline } from "./Offline.js";
import { ServerSetup } from "./ServerSetup.js";
import { NewSessionDialog } from "./NewSessionDialog.js";
import { Queue } from "./Queue.js";
import { Progress } from "./Progress.js";
import { Roster } from "./Roster.js";
import { SettingsDialog } from "./SettingsDialog.js";
import { ModelDialog } from "./ModelDialog.js";
import { StageHead } from "./StageHead.js";
import { StaleLink } from "./StaleLink.js";
import { Thread } from "./Thread.js";
import { Working } from "./Working.js";
import { BenchProvider } from "./context.js";
import { useCloseSpecialist } from "./useCloseSpecialist.js";
import { useDocumentTitle } from "./useDocumentTitle.js";
import { useDecision } from "./useDecision.js";
import { useGithub } from "./useGithub.js";
import { useQueue } from "./useQueue.js";
import { useSessionPlan } from "./useSessionPlan.js";
import { useDecisionKeys } from "./useDecisionKeys.js";
import { useRoster } from "./useRoster.js";
import { useSelection } from "./useSelection.js";
import { threadSignature, useThread } from "./useThread.js";
import { useHiddenProjects } from "../hidden.js";
import { isWaiting } from "../waiting.js";

/**
 * The whole cockpit. It owns the four things every screen reads — who exists,
 * who is selected, what they have said, and what they are waiting on — and
 * nothing else. Everything below is given what it needs and decides only how
 * to draw it.
 */
export function App() {
  const { rows, live } = useRoster();
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
  const [modelOpen, setModelOpen] = useState(false);
  const [githubOpen, setGithubOpen] = useState(false);
  const [queueOpen, setQueueOpen] = useState(false);
  // A copy of the cockpit on static hosting opens knowing nothing about any
  // daemon, and the first thing it has to do is ask.
  const [setupOpen, setSetupOpen] = useState(() => endpoint() === null);
  const everConnected = useRef(false);
  const hiddenProjects = useHiddenProjects();
  const input = useRef<HTMLTextAreaElement>(null);
  const note$ = useRef<HTMLTextAreaElement>(null);

  // Closing the one you were reading leaves the stage pointing at nothing.
  const closeSpecialist = useCloseSpecialist(
    useCallback((id: string) => { if (id === selectedId) select(null); }, [selectedId, select]),
  );
  // A tab per specialist is the normal way to use this, so the strip has to
  // be able to tell them apart - and say which of them has started wanting you.
  useDocumentTitle(rows, selectedId);

  const state = useMemo(() => ({ rows, selectedId }), [rows, selectedId]);
  const actions = useMemo(() => ({ select, closeSpecialist }), [select, closeSpecialist]);

  // Fetched only while the drawer is up: it is something you reach for, not a
  // panel that lives on screen.
  const github = useGithub(selectedId, githubOpen);

  // Every decision waiting on the developer, across every project. Fetched
  // only while the queue is open: it is a place you go, not a panel that
  // lives on screen.
  const queue = useQueue(rows, queueOpen);
  const waiting = rows.filter(isWaiting).length;

  // Fetched once here and given to both the checklist and the working strip,
  // which draws a bar from it - two pollers on one file would drift.
  const steps = useSessionPlan(selectedId, row?.status === "working");

  useEffect(() => { if (live === true) everConnected.current = true; }, [live]);

  // Silence from a daemon that has answered before is a restart, and the
  // banner says so. Silence from one that has never answered is usually the
  // wrong address - and the address is only ours to correct when somebody
  // typed it in the first place.
  useEffect(() => {
    const ask = shouldAskForServer({
      known: endpoint() !== null,
      live,
      everConnected: everConnected.current,
      remote: isRemote(),
    });
    if (ask) setSetupOpen(true);
  }, [live]);

  // Where the installed app's one shortcut lands. The hash is cleared as it
  // is read, so reloading the page you were left on does not reopen it.
  useEffect(() => {
    if (location.hash !== "#queue") return;
    history.replaceState(null, "", location.pathname + location.search);
    setQueueOpen(true);
  }, []);

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
    ? (answersFor(decision).length > 0 ? "options" as const : "reply" as const)
    : row && (row.status === "working" || row.status === "provisioning")
      ? "working" as const
      : "none" as const;

  return (
    <BenchProvider state={state} actions={actions}>
      <StaleLink />
      {/* One or the other: a refused socket is a stale link, and saying both
          would be describing the same silence twice. */}
      <Offline
        shown={live === false && !setupOpen}
        onChangeServer={isRemote() ? () => setSetupOpen(true) : null}
      />

      <main id="app">
        <aside id="roster">
          <header>
            <h1><Mark /><span>Bench</span></h1>
            <div className="header-actions">
              {/* Only when there is something in it. A queue that says zero
                  is a button that has to be read before it can be ignored. */}
              {waiting > 0 && (
                <button
                  id="open-queue"
                  type="button"
                  title={`${waiting} waiting on you`}
                  aria-label={`${waiting} waiting on you`}
                  onClick={() => setQueueOpen(true)}
                >
                  <BrainMark />
                  <span id="queue-badge">{waiting}</span>
                </button>
              )}
              <button id="new-session" type="button" onClick={() => setCreating(true)}>New</button>
            </div>
          </header>
          <ul id="roster-list"><Roster /></ul>

          {/* At the foot of the pane, where settings live in everything else.
              It is not something you reach for while working, and the header
              is for what you do reach for. */}
          <footer id="roster-foot">
            <button
              id="open-settings"
              type="button"
              title={hiddenProjects.size > 0
                ? `House rules, and ${hiddenProjects.size} hidden project${hiddenProjects.size === 1 ? "" : "s"}`
                : "House rules — how you want work done"}
              onClick={() => setSettingsOpen(true)}
            >
              <Gear />
              <span>Settings</span>
              {/* Said here rather than in a control of its own: a roster
                  missing a project has to explain itself, and this is the
                  door to putting it back. */}
              {hiddenProjects.size > 0 && (
                <span id="hidden-count">{hiddenProjects.size} hidden</span>
              )}
            </button>
          </footer>
        </aside>

        <section id="stage">
          <StageHead onGithub={() => setGithubOpen(true)} />
          {/* Where it has got to comes before what was said about it: the
              checklist is the answer to the question you opened this for. */}
          {/* An intake no longer competes for this room, so only a decision
              still drawn in the footer hides the checklist. */}
          <Progress decisionShowing={row !== null && isWaiting(row) && !intake} steps={steps} />
          <Thread
            entries={entries}
            sessionId={selectedId}
            hasRows={rows.length > 0}
            onOpen={setArtifact}
          />
          <Working steps={steps} />

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
              optionCount={decision ? answersFor(decision).length : 0}
              send={null}
              inputRef={input}
              error={error}
              model={row?.model}
              onChangeModel={() => setModelOpen(true)}
            />
          </footer>
        </section>
      </main>

      <ArtifactDialog
        open={artifact}
        sessionId={selectedId}
        onClose={() => setArtifact(null)}
        onReviewing={select}
      />
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
      <GithubDrawer
        open={githubOpen}
        list={github}
        project={row ? projectName(row.project) : null}
        onClose={() => setGithubOpen(false)}
      />
      <Queue
        items={queue}
        open={queueOpen}
        onClose={() => setQueueOpen(false)}
        onOpenSpecialist={select}
      />
      <NewSessionDialog open={creating} onClose={() => setCreating(false)} />
      <ServerSetup
        open={setupOpen}
        // Nothing to go back to until this page knows where its daemon is.
        onClose={endpoint() === null ? null : () => setSetupOpen(false)}
      />
      <SettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} />

      {/* Only ever for a specialist that exists. The roster carries the new
          model back, so nothing is held here that the daemon has not agreed
          to. */}
      {row && (
        <ModelDialog
          open={modelOpen}
          current={row.model ?? ""}
          sessionId={row.id}
          onClose={() => setModelOpen(false)}
        />
      )}
    </BenchProvider>
  );
}
