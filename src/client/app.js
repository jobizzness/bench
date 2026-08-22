const token = new URLSearchParams(location.search).get("token") ?? "";
const authHeaders = { "x-bench-token": token };

const state = {
  rows: [], selectedId: null, entries: [], decision: null, choice: null,
  /** `sessionId:reportSeq` of the decision on the table, so a roster tick
      does not reload it out from under a half-given answer. */
  decisionSeq: null,
  /** questionId -> { ids: Set<string>, text: string, touched: boolean } */
  answers: new Map(),
  /** Index into the currently visible question list, for the number keys. */
  focus: 0,
};
const collapsed = new Set();

const el = {
  list: document.getElementById("roster-list"),
  head: document.getElementById("stage-head"),
  headLabel: document.getElementById("stage-label"),
  headStatus: document.getElementById("stage-status"),
  thread: document.getElementById("thread"),
  decision: document.getElementById("decision"),
  kind: document.getElementById("decision-kind"),
  title: document.getElementById("decision-title"),
  summary: document.getElementById("decision-summary"),
  options: document.getElementById("decision-options"),
  intake: document.getElementById("intake"),
  brief: document.getElementById("intake-brief"),
  questions: document.getElementById("intake-questions"),
  assumed: document.getElementById("intake-assumed"),
  assumedCount: document.getElementById("intake-assumed-count"),
  assumedPreview: document.getElementById("intake-assumed-preview"),
  assumedQuestions: document.getElementById("intake-assumed-questions"),
  form: document.getElementById("composer-form"),
  text: document.getElementById("composer-text"),
  send: document.getElementById("composer-send"),
  hint: document.getElementById("composer-hint"),
  newSession: document.getElementById("new-session"),
  working: document.getElementById("working"),
  glyph: document.getElementById("working-glyph"),
  verb: document.getElementById("working-verb"),
  meta: document.getElementById("working-meta"),
};

const api = (path, init) =>
  fetch(path, { ...init, headers: { ...authHeaders, ...(init?.headers ?? {}) } });
const selectedRow = () => state.rows.find((r) => r.id === state.selectedId) ?? null;

function rosterRow(row) {
  const li = document.createElement("li");
  li.className = "row";
  li.dataset.status = row.status;
  li.setAttribute("aria-selected", String(row.id === state.selectedId));
  li.onclick = () => select(row.id);

  const label = document.createElement("div");
  label.className = "label";
  label.textContent = row.label;

  const detail = document.createElement("div");
  detail.className = "detail";
  detail.textContent = row.status === "awaiting_decision"
    ? row.detail
    : `${row.status.replace(/_/g, " ")} · ${row.detail}`;

  const close = document.createElement("button");
  close.className = "close";
  close.type = "button";
  close.textContent = "\u00d7";
  close.title = "Close this specialist";
  close.setAttribute("aria-label", `Close ${row.label}`);
  close.onclick = (event) => {
    // The row underneath selects a specialist; closing one must not.
    event.stopPropagation();
    closeSpecialist(row);
  };

  li.append(label, detail, close);
  return li;
}

/**
 * Closing is permanent - the record is what a restart reads - and it takes
 * the worktree with it. The daemon refuses when that would destroy work, and
 * says what, so the second question can be asked with the number in it.
 */
async function closeSpecialist(row) {
  if (!confirm(`Close ${row.label}?\n\nIts worktree and branch are removed. The thread and any reports are kept.`)) return;

  let res = await api(`/api/sessions/${row.id}/close`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  });

  if (res.status === 409) {
    const { changes, unmergedCommits } = await res.json();
    const lost = [
      changes ? `${changes} uncommitted file${changes === 1 ? "" : "s"}` : null,
      unmergedCommits ? `${unmergedCommits} commit${unmergedCommits === 1 ? "" : "s"} on no other branch` : null,
    ].filter(Boolean).join(" and ");

    if (!confirm(`${row.label} has ${lost}.\n\nClosing destroys that. Close anyway?`)) return;

    res = await api(`/api/sessions/${row.id}/close`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ force: true }),
    });
  }

  if (!res.ok) {
    el.hint.textContent = (await res.json()).error ?? "could not close";
    return;
  }

  if (state.selectedId === row.id) {
    state.selectedId = null;
    state.entries = [];
    state.decision = null;
  }
}

/**
 * Grouped by project, never flat. Working across many repos at once, a flat
 * list gives no way to tell which specialist belongs to which codebase.
 */
function renderRoster() {
  const groups = new Map();
  for (const row of state.rows) {
    if (!groups.has(row.project)) groups.set(row.project, []);
    groups.get(row.project).push(row);
  }

  el.list.replaceChildren(...[...groups.entries()].map(([project, allRows]) => {
    // Specialists waiting on you come first: several can need you at once,
    // so ordering is what makes the next one findable.
    const rows = [...allRows].sort((a, b) =>
      Number(b.status === "awaiting_decision") - Number(a.status === "awaiting_decision"));
    const group = document.createElement("details");
    group.className = "group";
    group.open = !collapsed.has(project);
    group.ontoggle = () => {
      if (group.open) collapsed.delete(project);
      else collapsed.add(project);
    };

    const summary = document.createElement("summary");
    summary.title = project;

    const name = document.createElement("span");
    name.textContent = project.split("/").filter(Boolean).pop() ?? project;
    summary.append(name);

    const waiting = rows.filter((r) => r.status === "awaiting_decision").length;
    const count = document.createElement("span");
    count.className = "count";
    count.dataset.waiting = String(waiting > 0);
    count.textContent = waiting > 0 ? `${waiting} waiting` : String(rows.length);
    summary.append(count);

    const list = document.createElement("ul");
    list.style.listStyle = "none";
    list.style.margin = "0";
    list.style.padding = "0";
    list.append(...rows.map(rosterRow));

    group.append(summary, list);
    return group;
  }));
}

const artifact = {
  root: document.getElementById("artifact-dialog"),
  kind: document.getElementById("artifact-kind"),
  title: document.getElementById("artifact-title"),
  tab: document.getElementById("artifact-tab"),
  frame: document.getElementById("artifact-frame"),
  close: document.getElementById("artifact-close"),
};

const artifactUrl = (seq, file) =>
  `/r/${state.selectedId}/${seq}/${file}?token=${encodeURIComponent(token)}`;

/**
 * A report is a page, so it opens as one. Unfolding it in place put a
 * document inside a 108ch column with the thread still scrolling underneath
 * it, which is the wrong shape for the one thing you are meant to read.
 */
function openArtifact({ label, title, seq, file }) {
  artifact.kind.textContent = label;
  artifact.title.textContent = title;
  artifact.tab.href = artifactUrl(seq, file);
  artifact.frame.src = artifactUrl(seq, file);
  artifact.root.showModal();
}

// Esc, the close button and the backdrop all land here, so the frame is torn
// down in one place - a hidden iframe left loaded keeps rendering.
artifact.root.addEventListener("close", () => artifact.frame.removeAttribute("src"));
artifact.close.onclick = () => artifact.root.close();
artifact.root.onclick = (event) => { if (event.target === artifact.root) artifact.root.close(); };

/**
 * Reports and replies are both rendered pages; only the file differs. Both
 * open in the dialog. A reply also previews in the thread, because a reply is
 * the answer to something you asked and reading it should not cost a click.
 */
function artifactCard({ label, title, seq, file, preview }) {
  const card = document.createElement("article");
  card.className = "card";

  const open = document.createElement("button");
  open.type = "button";
  open.className = "card-open";
  open.onclick = () => openArtifact({ label, title, seq, file });

  const kind = document.createElement("span");
  kind.className = "kind";
  kind.textContent = label;

  const heading = document.createElement("span");
  heading.className = "title";
  heading.textContent = title;

  const cue = document.createElement("span");
  cue.className = "cue";
  cue.textContent = "open";

  open.append(kind, heading, cue);
  card.append(open);

  if (preview) {
    const frame = document.createElement("iframe");
    frame.setAttribute("sandbox", "allow-same-origin");
    frame.title = title;
    frame.src = artifactUrl(seq, file);
    card.append(frame);
  }

  return card;
}

function relativeTime(iso) {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "";
  const seconds = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function emptyThread(heading, body) {
  const p = document.createElement("p");
  p.id = "empty";
  const b = document.createElement("b");
  b.textContent = heading;
  p.append(b, document.createTextNode(body));
  el.thread.replaceChildren(p);
}

function renderThread() {
  if (!state.selectedId) {
    return state.rows.length === 0
      ? emptyThread("No specialists yet.", "Start one with New and it will appear on the left.")
      : emptyThread("Nothing selected.", "Pick a specialist on the left to read what it has for you.");
  }
  if (state.entries.length === 0) {
    return emptyThread("Working.", "Nothing to read yet — the first report will land here.");
  }

  el.thread.replaceChildren(...state.entries.map((entry) => {
    const wrap = document.createElement("div");
    wrap.className = `entry ${entry.kind}`;

    const label = entry.kind === "user" ? "you" : entry.kind === "reply" ? "specialist" : "";
    if (label) {
      const who = document.createElement("div");
      who.className = "who";
      who.textContent = label;
      const when = document.createElement("span");
      when.className = "when";
      when.textContent = relativeTime(entry.at);
      who.append(when);
      wrap.append(who);
    }

    if (entry.kind === "report") {
      wrap.classList.add("wide");
      wrap.append(artifactCard({
        label: "report", title: entry.body, seq: entry.reportSeq, file: "report.html",
      }));
    } else if (entry.kind === "reply" && entry.replySeq) {
      // The specialist answered with a page. Preview it - it is the answer.
      wrap.classList.add("wide");
      wrap.append(artifactCard({
        label: "answer", title: entry.body, seq: entry.replySeq, file: "reply.html", preview: true,
      }));
    } else {
      const bubble = document.createElement("div");
      bubble.className = "bubble";
      bubble.textContent = entry.body;
      wrap.append(bubble);
    }
    return wrap;
  }));

  pinToBottom();
}

/**
 * Frames have no height until they load, so one scroll at render time
 * lands somewhere in the middle. Re-pin as each settles.
 */
function pinToBottom() {
  const jump = () => { el.thread.scrollTop = el.thread.scrollHeight; };
  jump();
  requestAnimationFrame(jump);
  for (const frame of el.thread.querySelectorAll("iframe")) {
    frame.addEventListener("load", jump, { once: true });
  }
}

/* ── Intake ─────────────────────────────────────────────────────────── */

/**
 * Asking one question, waiting, then asking the next never shows the shape
 * of what is unclear, and makes every question block equally. An intake
 * inverts that: the specialist answers its own questions first, shows all of
 * them at once, and only the ones it genuinely could not guess stand between
 * the developer and "go". The floor is one keypress; the ceiling is
 * overriding the two that matter.
 */

const isIntake = () => Boolean(state.decision && state.decision.questions.length);

function answerFor(question) {
  let answer = state.answers.get(question.id);
  if (!answer) {
    // Seeded from the specialist's own picks, so an untouched intake is
    // already a complete set of answers rather than an empty form.
    answer = {
      ids: new Set(question.options.filter((o) => o.default).map((o) => o.id)),
      text: "",
      touched: false,
    };
    state.answers.set(question.id, answer);
  }
  return answer;
}

const labelsFor = (question) =>
  question.options.filter((o) => answerFor(question).ids.has(o.id)).map((o) => o.label);

/** Free text alone counts: a question can be answered off the menu. */
function isAnswered(question) {
  const answer = answerFor(question);
  return answer.ids.size > 0 || answer.text.trim() !== "";
}

/**
 * Split on what the specialist could guess, not on what the developer has
 * done since - so a question never jumps between the two lists mid-read.
 */
function splitQuestions() {
  const open = [];
  const assumed = [];
  const guessed = (q) => q.options.some((o) => o.default);

  for (const question of state.decision.questions) {
    (question.stakes === "low" && guessed(question) ? assumed : open).push(question);
  }

  // A question the specialist could not guess is the only kind that blocks
  // sending, so it leads - the panel scrolls, and the first screen must not
  // hide the one thing standing in the way. The sort is on what the
  // specialist did, not on what you have answered since, so the order holds
  // still while you work down it.
  open.sort((a, b) => Number(guessed(a)) - Number(guessed(b)));
  return { open, assumed };
}

function pickOption(question, optionId) {
  const answer = answerFor(question);
  if (question.select === "many") {
    if (answer.ids.has(optionId)) answer.ids.delete(optionId);
    else answer.ids.add(optionId);
  } else {
    answer.ids = new Set([optionId]);
  }
  answer.touched = true;
  renderIntake();
}

const STATE_CHIP = {
  open: "needs you",
  changed: "your call",
  assumed: "assumed",
};

function questionState(question) {
  const answer = answerFor(question);
  if (answer.touched) return "changed";
  return isAnswered(question) ? "assumed" : "open";
}

function questionCard(question, index) {
  const card = document.createElement("section");
  card.className = "question";
  card.dataset.state = questionState(question);
  if (index !== null) card.dataset.focused = String(index === state.focus);

  const head = document.createElement("div");
  head.className = "q-head";

  if (index !== null) {
    const ordinal = document.createElement("span");
    ordinal.className = "q-ordinal";
    ordinal.textContent = String(index + 1);
    head.append(ordinal);
  }

  const ask = document.createElement("span");
  ask.className = "q-ask";
  ask.textContent = question.ask;
  head.append(ask);

  const chip = document.createElement("span");
  chip.className = "q-chip";
  chip.textContent = STATE_CHIP[questionState(question)];
  head.append(chip);
  card.append(head);

  if (question.why) {
    const why = document.createElement("p");
    why.className = "q-why";
    why.textContent = question.why;
    card.append(why);
  }

  const options = document.createElement("div");
  options.className = "q-options";
  options.append(...question.options.map((option, position) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "option";
    button.setAttribute("aria-pressed", String(answerFor(question).ids.has(option.id)));
    button.onclick = () => {
      if (index !== null) state.focus = index;
      pickOption(question, option.id);
    };

    // Keycaps only where a key would work: the folded questions are mouse
    // territory, and a number on them would be a promise the app breaks.
    if (index !== null && index === state.focus && position < 9) {
      const key = document.createElement("span");
      key.className = "key";
      key.textContent = String(position + 1);
      button.append(key);
    }

    const body = document.createElement("span");
    const label = document.createElement("span");
    label.className = "label";
    label.textContent = option.label;
    body.append(label);

    // The specialist's own pick, named as such. An answer you did not give
    // should never look like one you did.
    if (option.default) {
      const mine = document.createElement("span");
      mine.className = "mine";
      mine.textContent = "mine";
      body.append(mine);
    }

    if (option.hint) {
      const hint = document.createElement("span");
      hint.className = "hint";
      hint.textContent = option.hint;
      body.append(hint);
    }

    button.append(body);
    return button;
  }));
  card.append(options);

  if (question.allowFreeText) {
    const free = document.createElement("input");
    free.type = "text";
    free.className = "q-text";
    free.autocomplete = "off";
    free.placeholder = "or say it your own way";
    free.value = answerFor(question).text;
    free.setAttribute("aria-label", `Answer in your own words: ${question.ask}`);
    // Only the brief and the send bar redraw here. Rebuilding the card
    // would take the caret with it on every keystroke.
    free.oninput = () => {
      const answer = answerFor(question);
      answer.text = free.value;
      answer.touched = answer.text.trim() !== "" || answer.ids.size > 0;
      card.dataset.state = questionState(question);
      chip.textContent = STATE_CHIP[questionState(question)];
      renderBrief();
      renderSendBar();
    };
    card.append(free);
  }

  return card;
}

/**
 * The specialist writes one sentence with `{questionId}` holes in it. Filling
 * them live is the part no one-question-at-a-time flow can do: it needs every
 * answer at once, and it is what turns picking a label into reading a
 * consequence.
 */
function renderBrief() {
  const brief = state.decision?.brief;
  if (!brief) { el.brief.hidden = true; return; }
  el.brief.hidden = false;

  const byId = new Map(state.decision.questions.map((q) => [q.id, q]));
  const nodes = [];
  const pattern = /\{([A-Za-z0-9_-]+)\}/g;
  let last = 0;
  let match;

  while ((match = pattern.exec(brief)) !== null) {
    if (match.index > last) nodes.push(document.createTextNode(brief.slice(last, match.index)));
    const question = byId.get(match[1]);
    const slot = document.createElement("span");
    slot.className = "slot";

    if (!question) {
      // A hole naming no question is the specialist's mistake; showing it
      // raw beats quietly dropping half the sentence.
      slot.dataset.state = "missing";
      slot.textContent = match[0];
    } else {
      const spoken = labelsFor(question).join(" and ") || answerFor(question).text.trim();
      slot.dataset.state = questionState(question);
      // A slot with no answer is a blank to fill, not an em dash: "resets
      // ____ to the audit trail" reads as a sentence, "resets — to the
      // audit trail" reads as a bug.
      // Figure spaces: HTML collapses a run of ordinary ones to nothing,
      // leaving no width for the underline to draw.
      slot.textContent = spoken || "     ";
      slot.title = question.ask;
      slot.setAttribute("aria-label", spoken || `${question.ask} — unanswered`);
    }

    nodes.push(slot);
    last = match.index + match[0].length;
  }
  if (last < brief.length) nodes.push(document.createTextNode(brief.slice(last)));
  el.brief.replaceChildren(...nodes);
}

function renderIntake() {
  const { open, assumed } = splitQuestions();
  state.focus = Math.min(state.focus, Math.max(0, open.length - 1));

  el.questions.replaceChildren(...open.map((q, i) => questionCard(q, i)));

  el.assumed.hidden = assumed.length === 0;
  if (assumed.length) {
    el.assumedCount.textContent = `${assumed.length} more I've already assumed`;
    el.assumedPreview.textContent = assumed
      .map((q) => labelsFor(q).join(" and ") || answerFor(q).text.trim() || "—")
      .join(" · ");
    el.assumedQuestions.replaceChildren(...assumed.map((q) => questionCard(q, null)));
  }

  renderBrief();
  renderSendBar();
}

/**
 * The button says what pressing it will do, in the developer's terms. With
 * nothing overridden it reads as one keypress; with something unanswerable
 * outstanding it refuses and says how many.
 */
function renderSendBar() {
  const questions = state.decision.questions;
  const pending = questions.filter((q) => !isAnswered(q));
  const changed = questions.filter((q) => answerFor(q).touched);

  el.send.hidden = false;
  el.send.disabled = pending.length > 0;
  el.send.dataset.pending = String(pending.length > 0);
  el.send.textContent = pending.length > 0
    ? `${pending.length} still ${pending.length === 1 ? "needs" : "need"} you`
    : changed.length > 0
      ? `Send ${questions.length} answers · ${changed.length} yours`
      : `Go with all ${questions.length} assumptions`;

  const kbd = (t) => { const k = document.createElement("kbd"); k.textContent = t; return k; };
  el.hint.replaceChildren(
    kbd("1"), document.createTextNode("–"), kbd("9"), document.createTextNode(" pick  "),
    kbd("↑"), kbd("↓"), document.createTextNode(" move  "),
    kbd("↵"), document.createTextNode(" send  "),
    kbd("/"), document.createTextNode(" type instead"),
  );
}

function intakePayload() {
  return state.decision.questions.map((question) => {
    const answer = answerFor(question);
    return {
      questionId: question.id,
      ask: question.ask,
      labels: labelsFor(question),
      text: answer.text.trim(),
      defaulted: !answer.touched,
    };
  });
}

/* ── Composer ───────────────────────────────────────────────────────── */

function renderComposer() {
  const row = selectedRow();
  el.text.disabled = !row;

  if (!state.decision) {
    el.decision.hidden = true;
    el.send.hidden = true;
    el.kind.hidden = true;
    // A specialist that has never been prompted is waiting to be told what
    // it is for. That question used to be asked before it existed.
    el.text.placeholder = row && state.entries.length === 0
      ? "What should this specialist do?"
      : "Message this specialist";
    el.hint.replaceChildren();
    if (row && (row.status === "working" || row.status === "provisioning")) {
      el.hint.textContent = "Working — a message queues and is answered when this turn ends.";
    }
    return;
  }

  el.decision.hidden = false;
  el.decision.dataset.kind = state.decision.kind;
  el.title.textContent = state.decision.title;
  el.summary.textContent = state.decision.summary;

  if (isIntake()) {
    el.kind.hidden = false;
    el.kind.textContent = "before I build";
    el.intake.hidden = false;
    el.options.hidden = true;
    el.text.placeholder = "Anything else it should know";
    renderIntake();
    return;
  }

  el.kind.hidden = true;
  el.intake.hidden = true;
  el.options.hidden = false;
  el.send.hidden = true;
  el.text.placeholder = "Or type an answer";
  el.hint.replaceChildren();
  if (state.decision.options.length) {
    const kbd = (t) => { const k = document.createElement("kbd"); k.textContent = t; return k; };
    el.hint.append(
      kbd("1"), document.createTextNode("–"), kbd(String(state.decision.options.length)),
      document.createTextNode(" to pick  "), kbd("↵"), document.createTextNode(" to confirm  "),
      kbd("/"), document.createTextNode(" to type instead"),
    );
  } else {
    el.hint.textContent = "Press Enter to send.";
  }

  el.options.replaceChildren(...state.decision.options.map((option, index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "option";
    button.setAttribute("aria-pressed", String(state.choice === option.id));
    button.onclick = () => { state.choice = option.id; renderComposer(); };

    const key = document.createElement("span");
    key.className = "key";
    key.textContent = String(index + 1);

    const body = document.createElement("span");
    const label = document.createElement("span");
    label.className = "label";
    label.textContent = option.label;
    body.append(label);

    if (option.hint) {
      const hint = document.createElement("span");
      hint.className = "hint";
      hint.textContent = option.hint;
      body.append(hint);
    }

    button.append(key, body);
    return button;
  }));
}

/* ── Working indicator ──────────────────────────────────────────────── */

// Deliberately unhurried words. A specialist is reading and thinking, not
// spinning - the copy should say so without pretending to know what it is
// doing at any instant.
const VERBS = [
  "Reading", "Tracing", "Rummaging", "Untangling", "Cross-checking",
  "Squinting", "Collating", "Whittling", "Deliberating", "Circling back",
  "Following a hunch", "Second-guessing", "Reconsidering", "Digging",
];
const GLYPHS = ["✢", "✦", "✧", "✶"];

function hashOf(text) {
  let h = 0;
  for (let i = 0; i < text.length; i += 1) h = (h * 31 + text.charCodeAt(i)) | 0;
  return Math.abs(h);
}

function elapsedSince(iso) {
  const started = Date.parse(iso);
  if (Number.isNaN(started)) return "";
  const total = Math.max(0, Math.round((Date.now() - started) / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return minutes > 0 ? `${minutes}m ${String(seconds).padStart(2, "0")}s` : `${seconds}s`;
}

function formatTokens(n) {
  if (!n) return null;
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k tokens` : `${n} tokens`;
}

let tick = 0;

function renderWorking() {
  const row = selectedRow();
  const live = row && (row.status === "working" || row.status === "provisioning");

  if (!live || !state.selectedId) {
    el.working.hidden = true;
    return;
  }

  el.working.hidden = false;

  // The verb changes slowly, and is seeded per session so two specialists
  // working at once do not say the same thing.
  const seed = hashOf(row.id);
  const verb = VERBS[(seed + Math.floor(tick / 24)) % VERBS.length];

  el.glyph.textContent = GLYPHS[tick % GLYPHS.length];
  el.verb.textContent = row.status === "provisioning" ? "Preparing worktree" : verb;

  const parts = [];
  if (row.startedAt) parts.push(elapsedSince(row.startedAt));
  const tokens = formatTokens(row.tokens);
  if (tokens) parts.push(`↓ ${tokens}`);
  if (row.detail && row.status === "working") parts.push(row.detail);
  el.meta.textContent = parts.join("  ·  ");
}

// 250ms drives the glyph; everything else derives from it.
setInterval(() => { tick += 1; renderWorking(); }, 250);

function renderHead() {
  const row = selectedRow();
  el.head.hidden = !row;
  if (!row) return;
  el.headLabel.textContent = row.label;
  el.headStatus.textContent = `${row.status.replace(/_/g, " ")} · ${row.detail}`;
}

async function loadDecision(row) {
  if (!row || row.status !== "awaiting_decision" || row.latestReportSeq === null) {
    state.decision = null;
    state.decisionSeq = null;
    return;
  }

  // The roster pushes on every tick. Reloading unconditionally threw away
  // whatever had been chosen since the last one - survivable when that was a
  // single option, not when it is half an intake.
  const key = `${row.id}:${row.latestReportSeq}`;
  if (state.decisionSeq === key && state.decision) return;

  const res = await api(`/api/sessions/${row.id}/report/${row.latestReportSeq}`);
  state.decision = res.ok ? (await res.json()).decision : null;
  state.decisionSeq = state.decision ? key : null;
  state.choice = null;
  state.answers = new Map();
  state.focus = 0;
}

async function refreshThread() {
  if (!state.selectedId) { state.entries = []; return; }
  const res = await api(`/api/sessions/${state.selectedId}/thread`);
  state.entries = res.ok ? (await res.json()).entries : [];
}

async function select(id) {
  state.selectedId = id;
  await refreshThread();
  await loadDecision(selectedRow());
  renderRoster(); renderHead(); renderThread(); renderComposer(); renderWorking();
}

async function submit() {
  const row = selectedRow();
  if (!row) return;
  const text = el.text.value.trim();

  if (isIntake()) {
    // Every question carries an answer or the send bar is disabled, so
    // there is nothing to guard here beyond the button's own state.
    if (state.decision.questions.some((q) => !isAnswered(q))) return;
    await api(`/api/sessions/${row.id}/answer`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ answers: intakePayload(), text }),
    });
    state.decision = null;
    state.decisionSeq = null;
    state.answers = new Map();
  } else if (state.decision) {
    if (!state.choice && text === "") return;
    await api(`/api/sessions/${row.id}/answer`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ optionId: state.choice, text }),
    });
    state.decision = null;
    state.decisionSeq = null;
    state.choice = null;
  } else {
    if (text === "") return;
    const res = await api(`/api/sessions/${row.id}/message`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
    });
    if (!res.ok) {
      el.hint.textContent = (await res.json()).error ?? "could not send";
      return;
    }
  }

  el.text.value = "";
  await refreshThread();
  renderThread();
  renderComposer();
}

el.form.onsubmit = (event) => { event.preventDefault(); submit(); };

function scrollFocusedIntoView() {
  el.questions.querySelector('[data-focused="true"]')
    ?.scrollIntoView?.({ block: "nearest", behavior: "smooth" });
}

document.addEventListener("keydown", (event) => {
  // Every question can own a text field now, so the guard is "am I typing",
  // not "am I in the composer".
  const target = event.target;
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return;
  if (!state.decision) return;

  if (isIntake()) {
    const { open } = splitQuestions();
    if (open.length === 0) return;
    const focused = open[Math.min(state.focus, open.length - 1)];

    const index = Number(event.key) - 1;
    if (Number.isInteger(index) && index >= 0 && index < focused.options.length) {
      event.preventDefault();
      pickOption(focused, focused.options[index].id);
      return;
    }

    const step = event.key === "ArrowDown" || event.key === "j" ? 1
      : event.key === "ArrowUp" || event.key === "k" ? -1 : 0;
    if (step !== 0) {
      event.preventDefault();
      state.focus = Math.max(0, Math.min(state.focus + step, open.length - 1));
      renderIntake();
      scrollFocusedIntoView();
      return;
    }

    if (event.key === "Enter") {
      event.preventDefault();
      // Refusing silently would look broken. Jump to what is actually
      // blocking instead, and let the chip explain itself.
      const stuck = open.findIndex((q) => !isAnswered(q));
      if (stuck === -1) { submit(); return; }
      state.focus = stuck;
      renderIntake();
      scrollFocusedIntoView();
      return;
    }
    if (event.key === "/") { event.preventDefault(); el.text.focus(); }
    return;
  }

  const index = Number(event.key) - 1;
  const options = state.decision.options;
  if (Number.isInteger(index) && index >= 0 && index < options.length) {
    state.choice = options[index].id;
    renderComposer();
    return;
  }
  if (event.key === "Enter") { event.preventDefault(); submit(); }
  if (event.key === "/") { event.preventDefault(); el.text.focus(); }
});

const dialog = {
  root: document.getElementById("new-dialog"),
  form: document.getElementById("new-form"),
  project: document.getElementById("f-project"),
  projectList: document.getElementById("project-list"),
  label: document.getElementById("f-label"),
  model: document.getElementById("f-model"),
  error: document.getElementById("f-error"),
  cancel: document.getElementById("f-cancel"),
  create: document.getElementById("f-create"),
};

// Matches the daemon's own label rule, so a bad label is caught here with
// an explanation instead of coming back as an opaque 400.
const LABEL_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

let projects = [];

function showError(message) {
  dialog.error.textContent = message;
  dialog.error.hidden = !message;
}

async function loadProjects() {
  const res = await api("/api/projects");
  projects = res.ok ? (await res.json()).projects : [];
  dialog.projectList.replaceChildren(...projects.map((project) => {
    const option = document.createElement("option");
    option.value = project.name;
    option.label = project.path;
    return option;
  }));
}

/** Accepts either a listed repo name or a full absolute path. */
function resolveProject(value) {
  const match = projects.find((p) => p.name === value || p.path === value);
  if (match) return match.path;
  return value.startsWith("/") ? value : null;
}

el.newSession.onclick = async () => {
  showError("");
  dialog.form.reset();
  dialog.label.setAttribute("aria-invalid", "false");
  await loadProjects();
  dialog.root.showModal();
  dialog.project.focus();
};

dialog.cancel.onclick = () => dialog.root.close();

dialog.label.oninput = () => {
  const value = dialog.label.value;
  const bad = value !== "" && !LABEL_PATTERN.test(value);
  dialog.label.setAttribute("aria-invalid", String(bad));
};

dialog.form.onsubmit = async (event) => {
  event.preventDefault();
  showError("");

  const project = resolveProject(dialog.project.value.trim());
  if (!project) {
    showError("Pick a project from the list, or type an absolute path.");
    dialog.project.focus();
    return;
  }

  const label = dialog.label.value.trim();
  if (!LABEL_PATTERN.test(label)) {
    showError("Label must be lowercase letters, numbers and hyphens, starting with a letter or number.");
    dialog.label.focus();
    return;
  }

  dialog.create.disabled = true;
  try {
    const res = await api("/api/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ project, label, model: dialog.model.value }),
    });

    // The old prompt flow discarded this response, so a rejected request
    // produced no specialist and no explanation.
    if (!res.ok) {
      showError((await res.json()).error ?? "Could not create the specialist.");
      return;
    }
    dialog.root.close();
  } finally {
    dialog.create.disabled = false;
  }
};

function connect() {
  const socket = new WebSocket(`ws://${location.host}/events?token=${encodeURIComponent(token)}`);

  socket.onmessage = async (event) => {
    const message = JSON.parse(event.data);
    if (message.type !== "roster") return;

    state.rows = message.rows;
    renderRoster();
    renderHead();

    if (!state.selectedId) return;
    await refreshThread();
    await loadDecision(selectedRow());
    renderThread();
    renderComposer();
    renderWorking();
  };

  // The daemon outlives the UI, so a dropped socket is a reconnect.
  socket.onclose = () => setTimeout(connect, 1000);
}

renderComposer();
connect();
