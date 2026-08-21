const token = new URLSearchParams(location.search).get("token") ?? "";
const authHeaders = { "x-bench-token": token };

const state = { rows: [], selectedId: null, entries: [], decision: null, choice: null };
const collapsed = new Set();

const el = {
  list: document.getElementById("roster-list"),
  head: document.getElementById("stage-head"),
  headLabel: document.getElementById("stage-label"),
  headStatus: document.getElementById("stage-status"),
  thread: document.getElementById("thread"),
  decision: document.getElementById("decision"),
  title: document.getElementById("decision-title"),
  summary: document.getElementById("decision-summary"),
  options: document.getElementById("decision-options"),
  form: document.getElementById("composer-form"),
  text: document.getElementById("composer-text"),
  hint: document.getElementById("composer-hint"),
  newSession: document.getElementById("new-session"),
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

  const stateEl = document.createElement("div");
  stateEl.className = "state";
  stateEl.textContent = row.status.replace(/_/g, " ");

  const detail = document.createElement("div");
  detail.className = "detail";
  detail.textContent = row.detail;

  li.append(label, stateEl, detail);
  return li;
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

/** Reports and replies are both rendered pages; only the file differs. */
function artifactCard({ label, title, seq, file, open }) {
  const card = document.createElement("details");
  card.className = "card";
  card.open = Boolean(open);

  const summary = document.createElement("summary");
  const kind = document.createElement("span");
  kind.className = "kind";
  kind.textContent = label;
  const heading = document.createElement("span");
  heading.className = "title";
  heading.textContent = title;
  summary.append(kind, heading);

  const frame = document.createElement("iframe");
  frame.setAttribute("sandbox", "allow-same-origin");
  frame.title = title;

  const load = () => {
    if (!frame.src) {
      frame.src = `/r/${state.selectedId}/${seq}/${file}?token=${encodeURIComponent(token)}`;
    }
  };
  card.ontoggle = () => { if (card.open) load(); };
  if (card.open) load();

  card.append(summary, frame);
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

function emptyThread(message) {
  const p = document.createElement("p");
  p.id = "empty";
  p.textContent = message;
  el.thread.replaceChildren(p);
}

function renderThread() {
  if (!state.selectedId) return emptyThread("Select a specialist.");
  if (state.entries.length === 0) return emptyThread("No messages yet.");

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
      wrap.append(artifactCard({
        label: "report", title: entry.body, seq: entry.reportSeq, file: "report.html",
      }));
    } else if (entry.kind === "reply" && entry.replySeq) {
      // The specialist answered with a page. Open it - it is the answer.
      wrap.append(artifactCard({
        label: "answer", title: entry.body, seq: entry.replySeq, file: "reply.html", open: true,
      }));
    } else {
      const bubble = document.createElement("div");
      bubble.className = "bubble";
      bubble.textContent = entry.body;
      wrap.append(bubble);
    }
    return wrap;
  }));

  el.thread.scrollTop = el.thread.scrollHeight;
}

function renderComposer() {
  const row = selectedRow();
  el.text.disabled = !row;

  if (!state.decision) {
    el.decision.hidden = true;
    el.text.placeholder = "Message this specialist";
    el.hint.textContent = row && row.status === "working"
      ? "Working. A message queues and is answered when the current turn ends."
      : "";
    return;
  }

  el.decision.hidden = false;
  el.title.textContent = state.decision.title;
  el.summary.textContent = state.decision.summary;
  el.text.placeholder = "Or type an answer";
  el.hint.textContent = state.decision.options.length
    ? "Number keys pick, Enter confirms."
    : "Enter sends.";

  el.options.replaceChildren(...state.decision.options.map((option, index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "option";
    button.setAttribute("aria-pressed", String(state.choice === option.id));
    button.onclick = () => { state.choice = option.id; renderComposer(); };

    const key = document.createElement("span");
    key.className = "key";
    key.textContent = String(index + 1);
    button.append(key, document.createTextNode(option.label));

    if (option.hint) {
      const hint = document.createElement("span");
      hint.className = "hint";
      hint.textContent = option.hint;
      button.append(hint);
    }
    return button;
  }));
}

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
    return;
  }
  const res = await api(`/api/sessions/${row.id}/report/${row.latestReportSeq}`);
  state.decision = res.ok ? (await res.json()).decision : null;
  state.choice = null;
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
  renderRoster(); renderHead(); renderThread(); renderComposer();
}

async function submit() {
  const row = selectedRow();
  if (!row) return;
  const text = el.text.value.trim();

  if (state.decision) {
    if (!state.choice && text === "") return;
    await api(`/api/sessions/${row.id}/answer`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ optionId: state.choice, text }),
    });
    state.decision = null;
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

document.addEventListener("keydown", (event) => {
  if (event.target === el.text) return;
  if (!state.decision) return;

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
  task: document.getElementById("f-task"),
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

  const task = dialog.task.value.trim();
  if (task === "") {
    showError("Describe what this specialist should do.");
    dialog.task.focus();
    return;
  }

  dialog.create.disabled = true;
  try {
    const res = await api("/api/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ project, label, task, model: dialog.model.value }),
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
  };

  // The daemon outlives the UI, so a dropped socket is a reconnect.
  socket.onclose = () => setTimeout(connect, 1000);
}

renderComposer();
connect();
