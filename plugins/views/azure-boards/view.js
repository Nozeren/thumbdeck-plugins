// The Azure Boards view: your work items as a tree (what's under each, yours or not, and what
// they're under), the highlighted one's page beside them, laid out as Azure DevOps does. The
// backend asks Azure DevOps (backend.js); this shows what it has.
import { branchName, rows } from "./ado.js";
import { safe } from "./rich.js";

const td = window.thumbdeck;
const esc = td.escape;
const $ = (id) => document.getElementById(id);

let data = { items: [], error: "", updated: null, branchPrefix: "feature/" };
let cursor = 0;
let words = "";
let collapsed = new Set(); // ids whose children are hidden (kept in storage)
const details = new Map(); // id -> its page (backend.js detail) | { error }
const fresh = new Set(); // ids whose page was asked for since the last look (the others: asked again, shown meanwhile)
const asking = new Set();
const images = new Map(); // url -> data URL | null (couldn't) | a promise
let showing = null; // the id the details show (to keep where they're scrolled)

const shown = () => rows(data.items, { collapsed, words });
const current = () => shown()[cursor]?.it;
const STATES = [[/^(new|to do|proposed|open|design|approved)$/i, "proposed"], [/^(resolved|in review|testing)$/i, "resolved"],
  [/^(closed|done|completed)$/i, "done"], [/^removed$/i, "removed"]];
const stateClass = (s) => STATES.find(([re]) => re.test(s))?.[1] ?? "doing";
/** A field's value in words */
const valueText = (v) => (typeof v === "string" && /^\d{4}-\d\d-\d\dT/.test(v) ? new Date(v).toLocaleDateString() : v === true ? "Yes" : v === false ? "No" : String(v ?? ""));
const bytes = (n) => (n == null ? "" : n < 1024 ? `${n} B` : n < 1048576 ? `${Math.round(n / 1024)} KB` : `${(n / 1048576).toFixed(1)} MB`);
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
  const above = data.items.filter((i) => i.above).length;
  const under = data.items.length - mine - above;
  $("summary").textContent = data.items.length
    ? `${mine} open${under ? ` · ${under} under them` : ""}${above ? ` · ${above} above them` : ""}${words ? ` · ${list.filter((r) => r.it.title.toLowerCase().includes(words.toLowerCase()) || String(r.it.id) === words).length} match "${words}"` : ""}`
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

/** The highlighted work item's page: what the list knows at once, the rest when the backend has it */
function detail() {
  const it = current();
  const box = $("detail");
  if (!it) {
    showing = null;
    return (box.innerHTML = "");
  }
  const top = showing === it.id ? box.scrollTop : 0;
  showing = it.id;
  const d = details.get(it.id);
  const p = d && !d.error ? d : null;
  const rich = []; // html for the [data-rich] slots, made safe below
  const slot = (html) => `<div data-rich="${rich.push(html) - 1}"></div>`;
  const section = (title, body) => (body ? `<section><h3>${title}</h3>${body}</section>` : "");
  const fields = (list) => (list.length ? `<dl class="fields">${list.map((f) => `<dt>${esc(f.label)}</dt><dd>${esc(valueText(f.value))}</dd>`).join("")}</dl>` : "");
  const tags = it.tags.map((t) => `<span class="td-badge">${esc(t)}</span>`).join(" ");

  let main = d?.error ? `<p class="td-error">${esc(d.error)}</p>` : `<p class="td-muted">…</p>`;
  let side = "";
  if (p) {
    main = (p.rich.length ? p.rich.map((r) => section(esc(r.label), slot(r.html))).join("") : section("Description", `<p class="td-muted">No description.</p>`))
      + section(`Discussion <span class="td-muted">${p.comments.length || ""}</span>`, p.comments.map((c) => `<div class="comment">
          <div class="by">${esc(c.by)} <span class="td-muted">${esc(ago(c.at))}</span></div>${slot(c.html)}</div>`).join("") || `<p class="td-muted">No comments.</p>`);
    const kinds = [...new Set(["Parent", "Child", ...p.related.map((r) => r.kind)])];
    side = section("Related work", kinds.map((k) => {
        const of = p.related.filter((r) => r.kind === k);
        return of.length ? `<h4>${esc(k)}</h4><ul class="links">${of.map((r) => `<li class="link" data-goto="${r.id}" data-url="${esc(r.url)}">
          <span class="type ${esc(r.type)}">${esc(r.type)}</span> <span class="id">${r.id}</span> <span class="title">${esc(r.title)}</span>
          <span class="state"><i class="dot ${stateClass(r.state)}"></i>${esc(r.state)}</span></li>`).join("")}</ul>` : "";
      }).join(""))
      + section("Links", p.links.length ? `<ul class="links">${p.links.map((l) => `<li class="link" data-href="${esc(l.url)}">${esc(l.label)}</li>`).join("")}</ul>` : "")
      + section("Attachments", p.attachments.length ? `<ul class="links">${p.attachments.map((f) => `<li class="link" data-href="${esc(f.url)}">${esc(f.name)} <span class="td-muted">${bytes(f.size)}</span></li>`).join("")}</ul>` : "");
  }
  const development = `<ul class="links"><li><span class="td-muted">Branch name</span> <code>${esc(branchName(it, data.branchPrefix))}</code> <span class="td-muted">(y)</span></li>
    ${(p?.development ?? []).map((x) => `<li${x.url ? ` class="link" data-href="${esc(x.url)}"` : ""}><span class="td-muted">${esc(x.kind)}</span> ${esc(x.label)}</li>`).join("")}</ul>`;
  side = (p ? section("Planning", fields(p.planning)) : "") + section("Development", development) + side
    + section("Details", fields([...(p?.other ?? []), { label: "Project", value: it.project },
      ...(p ? [{ label: "Created", value: `${p.createdBy} · ${valueText(p.created)}` }] : [])]));

  box.innerHTML = `<header class="head"><i class="bar ${esc(it.type)}"></i>
      <div class="kind"><span class="type ${esc(it.type)}">${esc(it.type.toUpperCase())}</span> ${it.id}</div>
      <h2>${esc(it.title)}</h2>
      <div class="facts"><span>${esc(it.assignedTo || "Unassigned")}</span>
        <span><i class="dot ${stateClass(it.state)}"></i>${esc(it.state)}</span>
        ${p?.reason ? `<span class="td-muted">${esc(p.reason)}</span>` : ""}
        ${p?.changedBy ? `<span class="td-muted">Updated by ${esc(p.changedBy)} ${esc(ago(p.changed))}</span>` : ""}</div>
      <dl class="fields">${p?.area ? `<dt>Area</dt><dd>${esc(p.area)}</dd>` : ""}${it.iteration ? `<dt>Iteration</dt><dd>${esc(it.iteration)}</dd>` : ""}</dl>
      ${tags ? `<div class="tags">${tags}</div>` : ""}</header>
    <div class="cols"><div class="main">${main}</div><aside>${side}</aside></div>`;
  for (const el of box.querySelectorAll("[data-rich]")) el.replaceWith(safe(rich[el.dataset.rich]));
  pictures(box, it.id);
  box.scrollTop = top;

  if (!fresh.has(it.id) && !asking.has(it.id)) {
    asking.add(it.id);
    td.backend.call("detail", { id: it.id })
      .then((v) => details.set(it.id, v), (e) => !p && details.set(it.id, { error: e.message }))
      .finally(() => {
        asking.delete(it.id);
        fresh.add(it.id);
        if (showing === it.id) detail();
      });
  }
}

/** The images in the rich text: attachments need the token, so the backend gets them */
function pictures(box, id) {
  for (const img of box.querySelectorAll("img[data-src]")) {
    const url = img.dataset.src;
    const got = images.get(url);
    if (typeof got === "string") img.src = got;
    else if (got === null) {
      const link = document.createElement("a");
      link.dataset.href = url;
      link.textContent = img.alt ? `image: ${img.alt}` : "an image (opens in the browser)";
      img.replaceWith(link);
    } else if (!got) {
      images.set(url, td.backend.call("image", { url })
        .then((d) => images.set(url, d), () => images.set(url, null))
        .then(() => showing === id && detail()));
    }
  }
}

/** Shows a work item of the list (opening what it's under); false: it isn't in the list */
function select(id) {
  let it = data.items.find((i) => i.id === id);
  for (let n = 0; it && n < 50; n++, it = data.items.find((i) => i.id === it.parent)) if (it.id !== id) collapsed.delete(it.id);
  const at = shown().findIndex((r) => r.it.id === id);
  if (at < 0) return false;
  saveCollapsed();
  move(at);
  return true;
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
    case "page-down": return $("detail").scrollBy({ top: $("detail").clientHeight * 0.8 });
    case "page-up": return $("detail").scrollBy({ top: -$("detail").clientHeight * 0.8 });
    case "filter": return startFilter();
    case "refresh":
      fresh.clear();
      td.ui.say("looking again…");
      return td.backend.call("refresh").then(load);
  }
});
td.backend.on("updated", () => {
  fresh.clear();
  load();
});
document.addEventListener("click", (e) => {
  if (e.target.closest("#refresh")) return td.backend.call("refresh").then(load);
  const link = e.target.closest("[data-href]");
  if (link) return td.ui.openUrl(link.dataset.href);
  const go = e.target.closest("[data-goto]");
  if (go) return select(Number(go.dataset.goto)) || td.ui.openUrl(go.dataset.url);
  const t = e.target.closest("[data-toggle]");
  if (t && !words) return toggle(Number(t.dataset.toggle));
  const row = e.target.closest("[data-n]");
  if (row) move(Number(row.dataset.n));
});
document.addEventListener("dblclick", (e) => e.target.closest("[data-n]") && !e.target.closest("[data-toggle]") && current() && td.ui.openUrl(current().url));
setInterval(render, 60_000);
td.storage.get("collapsed").then((ids) => Array.isArray(ids) && (collapsed = new Set(ids)), () => {}).finally(load);
