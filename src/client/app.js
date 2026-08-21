const token = new URLSearchParams(location.search).get("token") ?? "";
const authHeaders = { "x-bench-token": token };

const state = { rows: [], selectedId: null, report: null, choice: null };

const el = {
  list: document.getElementById("roster-list"),
  empty: document.getElementById("empty"),
  frame: document.getElementById("report"),
  bar: document.getElementById("decision"),
  title: document.getElementById("decision-title"),
  summary: document.getElementById("decision-summary"),
  options: document.getElementById("decision-options"),
  freeForm: document.getElementById("decision-free"),
  freeText: document.getElementById("decision-text"),
  newSession: document.getElementById("new-session"),
};

function renderRoster() {
  el.list.replaceChildren(
    ...state.rows.map((row) => {
      const li = document.createElement("li");
      li.className = "row";
      li.setAttribute("aria-selected", String(row.id === state.selectedId));
      li.onclick = () => select(row.id);

      const label = document.createElement("div");
      label.className = "label";
      label.textContent = row.label;

      const status = document.createElement("div");
      status.className = "status";
      status.dataset.status = row.status;
      status.textContent = row.status.replace(/_/g, " ");

      const detail = document.createElement("div");
      detail.className = "detail";
      detail.textContent = row.detail;

      li.append(label, status, detail);
      return li;
    }),
  );
}

function renderDecision() {
  const report = state.report;
  if (!report) {
    el.bar.hidden = true;
    return;
  }

  el.bar.hidden = false;
  el.title.textContent = report.decision.title;
  el.summary.textContent = report.decision.summary;
  state.choice = null;

  el.options.replaceChildren(
    ...report.decision.options.map((option, index) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "option";
      button.setAttribute("aria-pressed", "false");
      button.onclick = () => choose(option.id);

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
    }),
  );

  el.freeForm.hidden = !report.decision.allowFreeText;
}

function choose(optionId) {
  state.choice = optionId;
  const options = state.report.decision.options;
  [...el.options.children].forEach((button, index) => {
    button.setAttribute("aria-pressed", String(options[index].id === optionId));
  });
}

async function select(id) {
  state.selectedId = id;
  const row = state.rows.find((r) => r.id === id);
  renderRoster();

  if (!row || row.latestReportSeq === null) {
    el.frame.hidden = true;
    el.empty.hidden = false;
    state.report = null;
    renderDecision();
    return;
  }

  const res = await fetch(`/api/sessions/${id}/report/${row.latestReportSeq}`, { headers: authHeaders });
  state.report = res.ok ? await res.json() : null;

  el.empty.hidden = true;
  el.frame.hidden = false;
  el.frame.src = `/r/${id}/${row.latestReportSeq}/report.html?token=${encodeURIComponent(token)}`;
  renderDecision();
}

async function submit() {
  if (!state.selectedId || !state.report) return;

  await fetch(`/api/sessions/${state.selectedId}/answer`, {
    method: "POST",
    headers: { ...authHeaders, "content-type": "application/json" },
    body: JSON.stringify({ optionId: state.choice, text: el.freeText.value }),
  });

  el.freeText.value = "";
  state.report = null;
  state.choice = null;
  renderDecision();
}

document.addEventListener("keydown", (event) => {
  if (event.target === el.freeText) {
    if (event.key === "Enter") { event.preventDefault(); submit(); }
    if (event.key === "Escape") el.freeText.blur();
    return;
  }

  if (!state.report) return;

  if (event.key === "/") { event.preventDefault(); el.freeText.focus(); return; }
  if (event.key === "Enter") { event.preventDefault(); submit(); return; }

  const index = Number(event.key) - 1;
  const options = state.report.decision.options;
  if (Number.isInteger(index) && index >= 0 && index < options.length) {
    choose(options[index].id);
  }
});

el.newSession.onclick = async () => {
  const project = prompt("Project path (inside WSL)", "/var/www/teledoctor");
  if (!project) return;
  const label = prompt("Label (lowercase, hyphens)", "task-one");
  if (!label) return;
  const task = prompt("What should the specialist do?");
  if (!task) return;

  await fetch("/api/sessions", {
    method: "POST",
    headers: { ...authHeaders, "content-type": "application/json" },
    body: JSON.stringify({ project, label, task, model: "opus" }),
  });
};

function connect() {
  const socket = new WebSocket(`ws://${location.host}/events?token=${encodeURIComponent(token)}`);

  socket.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.type !== "roster") return;

    state.rows = message.rows;
    renderRoster();

    const current = state.rows.find((r) => r.id === state.selectedId);
    if (current && current.status === "awaiting_decision" && !state.report) select(current.id);
  };

  // The daemon outlives the UI, so a dropped socket is a reconnect, not an error.
  socket.onclose = () => setTimeout(connect, 1000);
}

connect();
