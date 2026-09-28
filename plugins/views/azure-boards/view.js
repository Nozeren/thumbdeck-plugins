// The Azure Boards view: your work items, the highlighted one's details beside them. The backend
// asks Azure DevOps (backend.js); this shows what it has.
import { branchName } from "./ado.js";

const td = window.thumbdeck;
const esc = td.escape;
const $ = (id) => document.getElementById(id);

let data = { items: [], error: "", updated: null, branchPrefix: "feature/" };
let cursor = 0;
let words = "";
const details = new Map(); // id -> { description, comments } | "loading"

const shown = () => data.items.filter((i) => !words || i.title.toLowerCase().includes(words.toLowerCase()) || String(i.id) === words);
const ago = (iso) => {
  const m = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  return !Number.isFinite(m) ? "" : m < 60 ? `${Math.max(0, m)}m ago` : m < 1440 ? `${Math.floor(m / 60)}h ago` : `${Math.floor(m / 1440)}d ago`;
};

async function load() {
  data = await td.backend.call("list");
  cursor = Math.min(cursor, Math.max(0, shown().length - 1));
  render();
}

function render() {
  const list = shown();
  $("summary").textContent = data.items.length ? `${data.items.length} open${words ? ` · ${list.length} match "${words}"` : ""}` : "";
  $("updated").textContent = data.updated ? `looked ${ago(new Date(data.updated).toISOString())}` : "";
  $("error").hidden = !data.error;
  $("error").textContent = data.error;
  $("list").innerHTML = list.length
    ? list.map((i, n) => `<li class="wi${n === cursor ? " cursor" : ""}" data-n="${n}"><span class="id">${i.id}</span>
        <span class="type ${esc(i.type)}">${esc(i.type)}</span><span class="title">${esc(i.title)}</span>
        <span class="state">${esc(i.state)}</span></li>`).join("")
    : `<li class="empty">${data.error ? "" : data.updated ? "Nothing here: all done." : "Asking Azure DevOps…"}</li>`;
  $("list").querySelector(".cursor")?.scrollIntoView({ block: "nearest" });
  detail();
}

async function detail() {
  const it = shown()[cursor];
  if (!it) return ($("detail").innerHTML = "");
  const d = details.get(it.id);
  const tags = it.tags.map((t) => `<span class="td-badge">${esc(t)}</span>`).join(" ");
  $("detail").innerHTML = `<h2>${esc(it.title)}</h2>
    <dl><dt>${esc(it.type)}</dt><dd>#${it.id} · ${esc(it.state)}${it.priority ? ` · priority ${it.priority}` : ""}</dd>
    <dt>Project</dt><dd>${esc(it.project)}</dd>
    ${it.iteration ? `<dt>Iteration</dt><dd>${esc(it.iteration)}</dd>` : ""}
    ${it.assignedTo ? `<dt>Assigned to</dt><dd>${esc(it.assignedTo)}</dd>` : ""}
    <dt>Changed</dt><dd>${esc(ago(it.changed))}</dd>
    ${tags ? `<dt>Tags</dt><dd>${tags}</dd>` : ""}
    <dt>Branch</dt><dd><code>${esc(branchName(it, data.branchPrefix))}</code> <span class="td-muted">(y)</span></dd></dl>
    ${d === undefined || d === "loading" ? `<p class="td-muted">…</p>` : d.error ? `<p class="td-error">${esc(d.error)}</p>`
      : `${d.description ? `<pre>${esc(d.description)}</pre>` : `<p class="td-muted">No description.</p>`}
         ${d.comments.map((c) => `<div class="comment"><span class="by">${esc(c.by)} · ${esc(ago(c.at))}</span><pre>${esc(c.text)}</pre></div>`).join("")}`}`;
  if (d === undefined) {
    details.set(it.id, "loading");
    try {
      details.set(it.id, await td.backend.call("detail", { id: it.id }));
    } catch (e) {
      details.set(it.id, { error: e.message });
    }
    if (shown()[cursor]?.id === it.id) detail();
  }
}

function move(to) {
  cursor = Math.max(0, Math.min(shown().length - 1, to));
  render();
}

async function copy(textToCopy, what) {
  try {
    await navigator.clipboard.writeText(textToCopy);
    td.ui.say(`copied ${what}`);
  } catch {
    td.ui.say("couldn't copy to the clipboard", { error: true });
  }
}

function startFilter() {
  const f = $("filter");
  f.hidden = false;
  f.value = words;
  f.focus();
}

$("filter").addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    words = $("filter").value.trim();
    $("filter").blur();
    if (!words) $("filter").hidden = true;
  } else if (e.key === "Escape") {
    words = "";
    $("filter").hidden = true;
  } else return;
  cursor = 0;
  render();
});
$("filter").addEventListener("input", () => {
  words = $("filter").value.trim();
  cursor = 0;
  render();
});

td.on("key", ({ action }) => {
  const it = shown()[cursor];
  switch (action) {
    case "down": return move(cursor + 1);
    case "up": return move(cursor - 1);
    case "first": return move(0);
    case "last": return move(shown().length - 1);
    case "outside": return it && td.ui.openUrl(it.url);
    case "copy-branch": return it && copy(branchName(it, data.branchPrefix), "the branch name");
    case "copy-ref": return it && copy(`#${it.id} ${it.title}`, `#${it.id}`);
    case "filter": return startFilter();
    case "refresh":
      details.clear();
      td.ui.say("looking again…");
      return td.backend.call("refresh").then(load);
  }
});
td.backend.on("updated", () => {
  details.clear();
  load();
});
document.addEventListener("click", (e) => {
  if (e.target.closest("#refresh")) return td.backend.call("refresh").then(load);
  const row = e.target.closest("[data-n]");
  if (row) move(Number(row.dataset.n));
});
document.addEventListener("dblclick", (e) => e.target.closest("[data-n]") && shown()[cursor] && td.ui.openUrl(shown()[cursor].url));
setInterval(render, 60_000);
load();
