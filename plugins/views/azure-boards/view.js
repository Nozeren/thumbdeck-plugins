// The Azure Boards view: your work items as a tree (what's under each, yours or not), the
// highlighted one's details beside them. The backend asks Azure DevOps (backend.js); this shows
// what it has.
import { branchName, rows } from "./ado.js";

const td = window.thumbdeck;
const esc = td.escape;
const $ = (id) => document.getElementById(id);

let data = { items: [], error: "", updated: null, branchPrefix: "feature/" };
let cursor = 0;
let words = "";
let collapsed = new Set(); // ids whose children are hidden (kept in storage)
const details = new Map(); // id -> { description, comments } | "loading"

const shown = () => rows(data.items, { collapsed, words });
const current = () => shown()[cursor]?.it;
const ago = (iso) => {
  const m = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  return !Number.isFinite(m) ? "" : m < 60 ? `${Math.max(0, m)}m ago` : m < 1440 ? `${Math.floor(m / 60)}h ago` : `${Math.floor(m / 1440)}d ago`;
};

async function load() {
  const was = current()?.id;
  data = await td.backend.call("list");
  const at = shown().findIndex((r) => r.it.id === was);
  cursor = at >= 0 ? at : Math.min(cursor, Math.max(0, shown().length - 1));
  render();
}

function render() {
  const list = shown();
  const mine = data.items.filter((i) => i.mine).length;
  const under = data.items.length - mine;
  $("summary").textContent = data.items.length
    ? `${mine} open${under ? ` · ${under} under them` : ""}${words ? ` · ${list.filter((r) => r.it.title.toLowerCase().includes(words.toLowerCase()) || String(r.it.id) === words).length} match "${words}"` : ""}`
    : "";
  $("updated").textContent = data.updated ? `looked ${ago(new Date(data.updated).toISOString())}` : "";
  $("error").hidden = !data.error;
  $("error").textContent = data.error;
  $("list").innerHTML = list.length
    ? list.map(({ it: i, depth, kids, open }, n) => `<li class="wi${n === cursor ? " cursor" : ""}${i.mine ? "" : " other"}" data-n="${n}">
        <span class="twig" style="padding-left:${depth * 14}px">${kids ? `<span class="toggle" data-toggle="${i.id}">${open ? "▾" : "▸"}</span>` : ""}</span>
        <span class="id">${i.id}</span><span class="type ${esc(i.type)}">${esc(i.type)}</span><span class="title">${esc(i.title)}</span>
        ${i.mine ? "" : `<span class="who">${esc(i.assignedTo || "unassigned")}</span>`}<span class="state">${esc(i.state)}</span></li>`).join("")
    : `<li class="empty">${data.error ? "" : data.updated ? "Nothing here: all done." : "Asking Azure DevOps…"}</li>`;
  $("list").querySelector(".cursor")?.scrollIntoView({ block: "nearest" });
  detail();
}

async function detail() {
  const it = current();
  if (!it) return ($("detail").innerHTML = "");
  const parent = data.items.find((i) => i.id === it.parent);
  const under = data.items.filter((i) => i.parent === it.id).length;
  const d = details.get(it.id);
  const tags = it.tags.map((t) => `<span class="td-badge">${esc(t)}</span>`).join(" ");
  $("detail").innerHTML = `<h2>${esc(it.title)}</h2>
    <dl><dt>${esc(it.type)}</dt><dd>#${it.id} · ${esc(it.state)}${it.priority ? ` · priority ${it.priority}` : ""}</dd>
    <dt>Project</dt><dd>${esc(it.project)}</dd>
    ${parent ? `<dt>Under</dt><dd>#${parent.id} ${esc(parent.title)}</dd>` : ""}
    ${under ? `<dt>Has</dt><dd>${under} under it</dd>` : ""}
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
    if (current()?.id === it.id) detail();
  }
}

function saveCollapsed() {
  td.storage.set("collapsed", [...collapsed]).catch(() => {});
}

/** Shows or hides what's under a work item, keeping the cursor on the same one */
function toggle(id, open = collapsed.has(id)) {
  const was = current()?.id;
  if (open) collapsed.delete(id);
  else collapsed.add(id);
  saveCollapsed();
  const at = shown().findIndex((r) => r.it.id === was);
  cursor = at >= 0 ? at : Math.max(0, shown().findIndex((r) => r.it.id === id));
  render();
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
  const row = shown()[cursor];
  const it = row?.it;
  switch (action) {
    case "down": return move(cursor + 1);
    case "up": return move(cursor - 1);
    case "first": return move(0);
    case "last": return move(shown().length - 1);
    case "outside": return it && td.ui.openUrl(it.url);
    case "copy-branch": return it && copy(branchName(it, data.branchPrefix), "the branch name");
    case "copy-ref": return it && copy(`#${it.id} ${it.title}`, `#${it.id}`);
    case "open": // its children shown; then into them
      if (!row?.kids) return;
      return row.open ? move(cursor + 1) : toggle(it.id, true);
    case "close": // its children hidden; or up to its parent
      if (row?.kids && row.open && !words) return toggle(it.id, false);
      if (row?.depth) return move(shown().findIndex((r) => r.it.id === it.parent));
      return;
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
  const t = e.target.closest("[data-toggle]");
  if (t && !words) return toggle(Number(t.dataset.toggle));
  const row = e.target.closest("[data-n]");
  if (row) move(Number(row.dataset.n));
});
document.addEventListener("dblclick", (e) => e.target.closest("[data-n]") && !e.target.closest("[data-toggle]") && current() && td.ui.openUrl(current().url));
setInterval(render, 60_000);
td.storage.get("collapsed").then((ids) => Array.isArray(ids) && (collapsed = new Set(ids)), () => {}).finally(load);
