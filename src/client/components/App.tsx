import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { endpoint, isRemote, postJson } from "../api.js";
import { isProxied } from "../../shared/models.js";
import { useAttachments } from "./useAttachments.js";
import { shouldAskForServer } from "../endpoint.js";
import { answersFor } from "../../shared/decisions.js";
import { projectName } from "../format.js";
import { intakePayload, pickOption, sendBar } from "../intake.js";
import type { ArtifactRef } from "./ArtifactCard.js";
import { ArtifactDialog } from "./ArtifactDialog.js";
import { Composer } from "./Composer.js";
import { DecisionPanel, isIntake } from "./DecisionPanel.js";
import { DispatchModal } from "./DispatchModal.js";
import { Gear } from "./Gear.js";
import { GithubDrawer } from "./GithubDrawer.js";
import { IntakeCard } from "./IntakeCard.js";
import { IntakeSheet } from "./IntakeSheet.js";
import { BrainMark } from "./BrainMark.js";
import { Mark } from "./Mark.js";
import { Offline } from "./Offline.js";
import { ServerSetup } from "./ServerSetup.js";
import { SignIn } from "./SignIn.js";
import { useFirebaseUser } from "./useFirebaseUser.js";
import { NewSessionDialog } from "./NewSessionDialog.js";
import type { PendingMessage } from "./PendingEntry.js";
import { PhoneUnblock } from "./PhoneUnblock.js";
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
import { useHandoff } from "./useHandoff.js";
import { usePhoneLanding } from "./usePhoneLanding.js";
import { useRoster } from "./useRoster.js";
import { useSelection } from "./useSelection.js";
import { threadSignature, useThread } from "./useThread.js";
import { useHiddenProjects } from "../hidden.js";
import { isWaiting } from "../waiting.js";
import { useVisualViewportHeight } from "./useVisualViewportHeight.js";

/**
 * The whole cockpit. It owns the four things every screen reads — who exists,
 * who is selected, what they have said, and what they are waiting on — and
 * nothing else. Everything below is given what it needs and decides only how
 * to draw it.
 */
export function App() {
  const { selectedId, select: rawSelect } = useSelection();
  // Below the width breakpoint the composer has to survive a soft keyboard
  // that `100dvh` alone does not always account for - see the hook's own
  // comment and `#app` in styles.css.
  useVisualViewportHeight();
  const { rows, live, wakingMachines, degradedMachines, activeMachineName } = useRoster(selectedId);
  const row = rows.find((r) => r.id === selectedId) ?? null;

  // Below the breakpoint, which of the phone's screens is in front of the
  // developer - the roster, an open specialist, or something waiting.
  // Ignored above it: every rule that reads `effectivePane` lives inside the
  // mobile media query. `select` is reassigned to the wrapped version once
  // here, rather than at every call site below, so the rest of this file
  // reads exactly as it did before this hook existed.
  const landing = usePhoneLanding(rows, selectedId, rawSelect);
  const select = landing.select;

  const { entries, reload, threadUnreachable, loading: threadLoading } = useThread(selectedId, threadSignature(row));
  const decisionState = useDecision(row);
  const { decision, answers, setAnswers, choice, setChoice, focus, setFocus, dismiss } = decisionState;

  const [text, setText] = useState("");
  const {
    attachments,
    error: attachmentError,
    addFiles,
    removeAttachment,
    clearAttachments,
    restoreIfEmpty: restoreAttachmentsIfEmpty,
  } = useAttachments();
  // A plain message on screen before the daemon has answered for it - see
  // `submit()` below (#86). Keyed locally, never by a real `seq`, and one
  // list across every specialist rather than one per row - `pendingForRow`
  // is what keeps a message sent to one from showing up in another's thread
  // while it is still in flight.
  const [pending, setPending] = useState<PendingMessage[]>([]);
  const pendingForRow = useMemo(
    () => pending.filter((message) => message.sessionId === selectedId),
    [pending, selectedId],
  );
  // What the send control shows - idle by default, "sending" for the length
  // of whichever POST is currently in flight (optimistic or not), "failed"
  // for a beat after one comes back bad. Purely visual: nothing here gates
  // whether the next message can be typed or sent.
  const [sendState, setSendState] = useState<"idle" | "sending" | "failed">("idle");
  const sendStateReset = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Held long enough to read, then back to idle on its own - the same
  // "failed" is not a permanent mark, someone is going to try again in a
  // few seconds either way.
  const failSend = useCallback(() => {
    setSendState("failed");
    if (sendStateReset.current) clearTimeout(sendStateReset.current);
    sendStateReset.current = setTimeout(() => setSendState("idle"), 2400);
  }, []);
  useEffect(() => () => { if (sendStateReset.current) clearTimeout(sendStateReset.current); }, []);
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
  // daemon, and usually has to ask - unless it is signed into Firebase, in
  // which case it is not lost, it is a phone. Starts closed rather than
  // guessing: whether to open it, and to which screen, waits for
  // `firebaseUser.loading` to resolve, in the effect below.
  const [setupOpen, setSetupOpen] = useState(false);
  // Overrides the sign-in screen for someone who meant to type an address -
  // "point at a daemon directly" is a fallback, not a dead end either way.
  const [wantsAddress, setWantsAddress] = useState(false);
  const firebaseUser = useFirebaseUser();
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

  const state = useMemo(() => ({ rows, selectedId, live }), [rows, selectedId, live]);
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

  // A specialist handing work to a tab it just opened does it while you are
  // reading that specialist, so that is where the hand-off is put in front of
  // you - not only on the new tab, which nobody would think to click.
  const handoff = useHandoff(rows, selectedId);

  // Silence from a daemon that has answered before is a restart, and the
  // banner says so. Silence from one that has never answered is usually the
  // wrong address - and the address is only ours to correct when somebody
  // typed it in the first place.
  useEffect(() => {
    if (firebaseUser.loading) return;
    const ask = shouldAskForServer({
      known: endpoint() !== null,
      live,
      everConnected: everConnected.current,
      remote: isRemote(),
      signedIn: firebaseUser.user !== null,
    });
    if (ask) setSetupOpen(true);
  }, [live, firebaseUser.loading, firebaseUser.user]);

  // Where the installed app's one shortcut lands. The hash is cleared as it
  // is read, so reloading the page you were left on does not reopen it.
  useEffect(() => {
    if (location.hash !== "#queue") return;
    history.replaceState(null, "", location.pathname + location.search);
    setQueueOpen(true);
  }, []);

  const intake = isIntake(decision);
  const bar = decision && intake ? sendBar(decision, answers) : null;

  // An intake wants the whole page - its brief rewrites itself as you
  // answer, which does not fit the unblock screen's single column - so it
  // is handed to the ordinary stage instead, the same way Queue.tsx already
  // hands one over rather than answering it in place. usePhoneLanding
  // decides everything else about where you land without knowing what kind
  // of decision it found; these are the overrides on top of it.
  //
  // A tab held on a hand-off is the other one. It wants the developer as
  // much as an unanswered decision does, so the phone now lands on it (#75) -
  // but it has no report and no decision, and the unblock screen is built
  // out of both. What it needs is the dispatch modal, and that opens over
  // the ordinary stage.
  const heldForDispatch = row?.status === "awaiting_dispatch";
  const effectivePane = landing.pane === "unblock" && (intake || heldForDispatch)
    ? "stage"
    : landing.pane;

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

    // If on a proxied model and there are attachments, prompt the user to switch to a Claude model.
    if (isProxied(row.model) && attachments.length > 0) {
      if (confirm("This specialist runs on a proxied model, which cannot accept images.\n\nWould you like to switch to a Claude model?")) {
        setModelOpen(true);
      }
      return;
    }

    // An intake is answered in its own sheet, so the composer beneath it is
    // what it always was: a way to say something to the specialist. This
    // path is unchanged by #86 - a decision is one thing being resolved, not
    // a message joining a conversation, and dismissing it early would leave
    // the footer showing options that had, from the daemon's side, already
    // been overtaken.
    if (decision && !intake) {
      if (!choice && said === "" && attachments.length === 0) return;
      setSendState("sending");
      const res = await postJson(`/api/sessions/${row.id}/answer`, { optionId: choice, text: said, images: attachments });
      if (!res.ok) {
        setError((await res.json()).error ?? "could not send");
        failSend();
        return;
      }
      dismiss();
      setSendState("idle");
      setText("");
      clearAttachments();
      await reload();
      return;
    }

    if (said === "" && attachments.length === 0) return;

    // Optimistic (#86): the whole of "takes too long" was two round trips -
    // the POST, then a full thread refetch - before anything on screen
    // moved, over a relay where each one can be seconds. Clearing the box
    // and putting the message in the thread happen here, before either
    // trip; the POST and the reload that confirms it both happen behind
    // that, in the background.
    const id = `pending-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const sentText = said;
    const sentImages = attachments;
    setText("");
    clearAttachments();
    setPending((current) => [
      ...current,
      { id, sessionId: row.id, text: sentText, images: sentImages, at: new Date().toISOString() },
    ]);
    setSendState("sending");

    const giveUp = (message: string) => {
      // Restore what was typed rather than swallow it (#60's precedent) -
      // but only into a box nobody has since started a new draft in.
      // Typing something else while this one was in flight is the
      // developer moving on; putting the failed text back over it would be
      // the one thing worse than the failure itself. Read through the
      // updater rather than the `text`/`attachments` this closure caught at
      // call time, which is stale by now - the same reason a plain
      // `attachments.length` check would be wrong here.
      setPending((current) => current.filter((p) => p.id !== id));
      setText((current) => (current.trim() === "" ? sentText : current));
      restoreAttachmentsIfEmpty(sentImages);
      setError(message);
      failSend();
    };

    let res: Response;
    try {
      res = await postJson(`/api/sessions/${row.id}/message`, { text: sentText, images: sentImages });
    } catch {
      giveUp("Didn't send. Check the connection and try again.");
      return;
    }
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      giveUp(body.error ?? "could not send");
      return;
    }

    await reload();
    setPending((current) => current.filter((p) => p.id !== id));
    setSendState("idle");
  }

  useDecisionKeys({
    // With the sheet closed, 1-9 would be changing answers nobody can see.
    // The keys belong to whatever is actually in front of you - and on the
    // phone's unblock screen that is PhoneUnblock's own choice/text state,
    // not this one, even though the stage underneath is still holding the
    // same decision (see effectivePane below).
    decision: (intake && !sheetOpen) || effectivePane === "unblock" ? null : decision,
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
    // Not while the thread simply failed to arrive, or has not loaded yet:
    // asking what a specialist is for, mid-conversation, is the same lie the
    // empty thread told (#62, and the loading case #80 - the read this reads
    // off of is the one the skeleton in `Thread.tsx` is standing in for).
    : row && entries.length === 0 && !threadUnreachable && !threadLoading
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

      {/* Which pane is full-width below the breakpoint. Above it every rule
          that reads this ignores the value entirely, so `#roster` and
          `#stage` stay exactly what they always were - the two extra values
          only ever mean anything inside `@media (max-width: 720px)`, where
          `#unblock` and `#empty` live too (see `usePhoneLanding.ts`). */}
      <main id="app" data-pane={effectivePane}>
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

          {/* A remote machine that is running but has not mirrored anything
              for this viewer yet - idling can take up to a minute to notice
              a new one. Said plainly rather than left as an empty roster
              that looks the same as nothing being broadcast there. */}
          {wakingMachines.length > 0 && (
            <p id="waking-machines" className="field-note">
              Waking {wakingMachines.map((m) => m.name).join(", ")}…
            </p>
          )}

          {/* A machine quietly slowing its own mirror down near the daily
              write ceiling - said plainly rather than left to be noticed as
              staleness with no explanation. See "The write budget" in the
              design. */}
          {degradedMachines.length > 0 && (
            <p id="degraded-machines" className="field-note">
              {degradedMachines.map((m) => m.name).join(", ")} {degradedMachines.length === 1 ? "is" : "are"}{" "}
              near today's Firestore limit and updating more slowly.
            </p>
          )}

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
            unreachable={threadUnreachable}
            loading={threadLoading}
            pending={pendingForRow}
          />
          <Working steps={steps} />

          <footer id="composer">
            {/* An intake is a sheet; what stays down here is the door back to
                it. Everything smaller is still answered in place. */}
            {decision && intake && bar && (
              <IntakeCard decision={decision} send={bar} onOpen={() => setSheetOpen(true)} />
            )}
            {/* Not shown while the unblock screen owns this same decision -
                CSS already hides all of #app there, but rendering a second,
                fully wired copy of the options underneath is the kind of
                thing that only looks harmless until something reaches it -
                a focus ring, a keyboard shortcut, a test. */}
            {decision && !intake && effectivePane !== "unblock" && (
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
              answeredBy={row?.answeredBy}
              onChangeModel={() => setModelOpen(true)}
              project={row?.project}
              attachments={attachments}
              addFiles={addFiles}
              removeAttachment={removeAttachment}
              attachmentError={attachmentError}
              sendState={sendState}
            />
          </footer>
        </section>
      </main>

      {/* Siblings of #app, not children of it: the rule that hides #app
          below the breakpoint when one of these is showing
          (`#app[data-pane="unblock"] { display: none }`) would hide its own
          descendants too if these lived inside it. */}
      {effectivePane === "unblock" && row && (
        <PhoneUnblock
          row={row}
          decision={decision}
          decisionSettled={decisionState.settled}
          waitingCount={landing.waitingCount}
          onAnswered={() => { landing.advance(row); dismiss(); }}
          onBrowseRoster={landing.browseRoster}
        />
      )}

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
      <NewSessionDialog
        open={creating}
        onClose={() => setCreating(false)}
        onNeedKey={() => { setCreating(false); setSettingsOpen(true); }}
      />
      {/* No endpoint, nobody signed in: sign-in is the front door, not this.
          "Where is Bench running?" is what someone reaches for on purpose,
          via the link below - see "The phone's first screen is sign-in" in
          the design. */}
      {setupOpen && endpoint() === null && firebaseUser.user === null && !wantsAddress
        ? (
          <SignIn
            busy={false}
            error={firebaseUser.error}
            onSignIn={() => void firebaseUser.signIn()}
            onUseAddressInstead={() => setWantsAddress(true)}
          />
        )
        : (
          <ServerSetup
            open={setupOpen}
            // Nothing to go back to only when none of the three ways out of
            // this screen apply: no known daemon, nobody signed in, and this
            // was not reached by deliberately asking for it from `SignIn` -
            // which is exactly when `SignIn` would be showing instead of this.
            onClose={endpoint() === null && firebaseUser.user === null && !wantsAddress
              ? null
              : () => { setSetupOpen(false); setWantsAddress(false); }}
          />
        )}
      <SettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} activeMachineName={activeMachineName} />

      {/* Only ever for a specialist that exists. The roster carries the new
          model back, so nothing is held here that the daemon has not agreed
          to. */}
      {row && (
        <ModelDialog
          open={modelOpen}
          current={row.model ?? ""}
          sessionId={row.id}
          reasoningEffort={row.reasoningEffort}
          onClose={() => setModelOpen(false)}
          onNeedKey={() => { setModelOpen(false); setSettingsOpen(true); }}
        />
      )}
      <DispatchModal
        open={handoff.open}
        row={handoff.held}
        onClose={handoff.close}
        // The hand-off stays up underneath: adding a key is an errand, and
        // what you were doing when you left for it is still what you came
        // here to do.
        onNeedKey={() => setSettingsOpen(true)}
      />
    </BenchProvider>
  );
}
