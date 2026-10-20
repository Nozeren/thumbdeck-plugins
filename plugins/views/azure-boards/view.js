// The Azure Boards view: your work items as a tree (what's under each, yours or not, and what
// they're under), the highlighted one's page beside them, laid out as Azure DevOps does, and
// the changes you make to them (state, assignee, a comment, time in a work log…); the hours you
// logged, day by day (w: a calendar); a search (F). Any other work item (one in the calendar, a
// search, Related work, a #123 link) opens its page here too, and Esc goes back. The backend asks
// Azure DevOps (backend.js); this shows what it has.
import { branchName, isMe, rows, sprintOnly } from "./ado.js";
import { byDay, dayKey, hoursText, weeks } from "./hours.js";
import { safe } from "./rich.js";

const td = window.thumbdeck;
const esc = td.escape;
const $ = (id) => document.getElementById(id);

let data = { items: [], error: "", updated: null, branchPrefix: "feature/", sprints: {}, sprintOnly: false };
let cursor = 0;
let words = "";
let collapsed = new Set(); // ids whose children are hidden (kept in storage)
const details = new Map(); // id -> its page (backend.js detail) | { error }
const fresh = new Set(); // ids whose page was asked for since the last look (the others: asked again, shown meanwhile)
const asking = new Set();
const images = new Map(); // url -> data URL | null (couldn't) | a promise
let showing = null; // the id the details show (to keep where they're scrolled)

/** The work items it shows: every iteration's, or the current sprint's */
const visible = () => (data.sprintOnly ? sprintOnly(data.items) : data.items);
const shown = () => rows(visible(), { collapsed, words });
const current = () => shown()[cursor]?.it;
/** The work item whose page shows: the list's highlighted one, or the one opened on its own */
const showingItem = () => (mode === "page" ? pageItem() : mode === "list" ? current() : null);
const STATES = [[/^(new|to do|proposed|open|design|approved)$/i, "proposed"], [/^(resolved|in review|testing)$/i, "resolved"],
  [/^(closed|done|completed)$/i, "done"], [/^removed$/i, "removed"]];
const stateClass = (s) => STATES.find(([re]) => re.test(s))?.[1] ?? "doing";
// A work item type's mark in the list (its colour: view.css)
const MARKS = [[/^epic$/i, "▲"], [/^feature$/i, "◆"], [/^(user story|product backlog item|requirement)$/i, "■"], [/^bug$/i, "●"],
  [/^task$/i, "▪"], [/^(issue|impediment)$/i, "◇"]];
const mark = (type) => MARKS.find(([re]) => re.test(type))?.[1] ?? "•";
/** A field's value in words (format: the backend's, for a field it knows) */
const valueText = (v, format) =>
  (format === "date" || (!format && typeof v === "string" && /^\d{4}-\d\d-\d\dT/.test(v))) && !Number.isNaN(Date.parse(v)) ? new Date(v).toLocaleDateString()
    : v === true ? "Yes" : v === false ? "No" : String(v ?? "");
const bytes = (n) => (n == null ? "" : n < 1024 ? `${n} B` : n < 1048576 ? `${Math.round(n / 1024)} KB` : `${(n / 1048576).toFixed(1)} MB`);
const ago = (iso) => {
  const m = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  return !Number.isFinite(m) ? "" : m < 60 ? `${Math.max(0, m)}m ago` : m < 1440 ? `${Math.floor(m / 60)}h ago` : `${Math.floor(m / 1440)}d ago`;
};

async function load() {
  const was = current()?.id;
  data = await td.backend.call("list");
  await seenFor(data.items);
  const at = shown().findIndex((r) => r.it.id === was);
  cursor = at >= 0 ? at : Math.min(cursor, Math.max(0, shown().length - 1));
  render();
}

function render() {
  lookingAt(showingItem());
  const list = shown();
  const all = visible();
  const mine = all.filter((i) => i.mine).length;
  const above = all.filter((i) => i.above).length;
  const under = all.length - mine - above;
  const sprints = [...new Set(Object.values(data.sprints ?? {}).filter(Boolean).map((p) => p.split("\\").pop()))];
  $("summary").textContent = data.items.length
    ? `${data.sprintOnly ? `${sprints.join(", ") || "no current sprint found"} · ` : ""}${mine} open${under ? ` · ${under} under them` : ""}${above ? ` · ${above} above them` : ""}${words ? ` · ${list.filter((r) => r.it.title.toLowerCase().includes(words.toLowerCase()) || String(r.it.id) === words).length} match "${words}"` : ""}`
    : "";
  $("updated").textContent = data.updated ? `looked ${ago(new Date(data.updated).toISOString())}` : "";
  $("error").hidden = !data.error;
  $("error").textContent = data.error;
  $("sprint").classList.toggle("on", !!data.sprintOnly);
  $("sprint").title = data.sprintOnly ? "Showing the current sprint's: every iteration's (i)" : "Only the current sprint's (i)";
  const warnings = [data.note, data.warning && `Fields setting: ${data.warning}`].filter(Boolean);
  $("warning").hidden = !warnings.length;
  $("warning").textContent = warnings.join(" · ");
  $("list").innerHTML = list.length
    ? list.map(({ it: i, depth, kids, open }, n) => `<li class="wi${n === cursor ? " cursor" : ""}${i.mine ? "" : " other"}${unseen(i) ? " unseen" : ""}" data-n="${n}"
        title="${esc(`${i.type} ${i.id} · ${i.state} · ${i.assignedTo || "unassigned"}\n${i.title}`)}">
        <span class="twig" style="padding-left:${depth * 12}px">${kids ? `<span class="toggle" data-toggle="${i.id}">${open ? "▾" : "▸"}</span>` : ""}</span>
        <span class="mark ${esc(i.type)}">${mark(i.type)}</span><span class="id">${i.id}</span><span class="title">${esc(i.title)}</span>
        <i class="dot ${stateClass(i.state)}"></i></li>`).join("")
    : `<li class="empty">${data.error ? "" : !data.updated ? "Asking Azure DevOps…" : data.sprintOnly && data.items.length ? "Nothing of yours in the current sprint (i: every iteration's)." : "Nothing here: all done."}</li>`;
  $("list").querySelector(".cursor")?.scrollIntoView({ block: "nearest" });
  detail();
}

// Fields on the page that change with a click (by reference name; the rest: in the properties)
const EDITABLE = { "Microsoft.VSTS.Common.Priority": "priority" };
/** A key's badge, beside what it does */
const kbd = (key) => `<kbd>${esc(key)}</kbd>`;
/** A work item as one line, for a commit or a message: "TASK 1234 Its title" */
const reference = (it) => `${it.type.toUpperCase()} ${it.id} ${it.title}`;
const lastPart = (path) => String(path ?? "").split("\\").pop();
const since = (at, then) => !!then && Date.parse(at) > Date.parse(then);

/** An event of the history in words (after who did it) */
function eventText(e) {
  const dot = (state) => `<i class="dot ${stateClass(state)}"></i>${esc(state)}`;
  const tags = (x) => String(x ?? "").split(";").map((t) => t.trim()).filter(Boolean);
  switch (e.kind) {
    case "created": return `created it${e.to ? ` as ${dot(e.to)}` : ""}`;
    case "state": return `changed the state ${e.from ? `${dot(e.from)} → ` : "to "}${dot(e.to)}`;
    case "assignee": return e.to ? (e.from ? `reassigned it from ${esc(e.from)} to <b>${esc(e.to)}</b>` : `assigned it to <b>${esc(e.to)}</b>`) : `unassigned it (was ${esc(e.from)})`;
    case "iteration": return `moved it ${e.from ? `from ${esc(lastPart(e.from))} ` : ""}to <b>${esc(lastPart(e.to))}</b>`;
    case "area": return `changed the area to ${esc(e.to)}`;
    case "title": return `renamed it “${esc(e.to)}”`;
    case "priority": return `changed the priority ${esc(e.from || "—")} → <b>${esc(e.to || "—")}</b>`;
    case "tags": {
      const added = tags(e.to).filter((t) => !tags(e.from).includes(t));
      const removed = tags(e.from).filter((t) => !tags(e.to).includes(t));
      return [added.length && `tagged it ${added.map((t) => `<span class="td-badge">${esc(t)}</span>`).join(" ")}`,
        removed.length && `removed ${removed.map((t) => `<span class="td-badge">${esc(t)}</span>`).join(" ")}`].filter(Boolean).join(", ") || "changed the tags";
    }
    case "parent": return e.to ? `put it under <a class="link" data-goto="${e.to}" data-url="">#${e.to}</a>` : `took it out of #${esc(e.from)}`;
    case "development": return `linked a ${esc(String(e.to).toLowerCase())}`;
    default: return esc(e.kind);
  }
}

/** The highlighted work item's page: a header; its text, then its activity (comments and
 *  history, what's new since you last looked marked), a comment to write; its properties
 *  beside them, each changed with a click */
function detail() {
  const it = showingItem();
  const box = $("detail");
  if (!it) {
    showing = null;
    return (box.innerHTML = "");
  }
  const top = showing === it.id ? box.scrollTop : 0;
  showing = it.id;
  const d = details.get(it.id);
  const p = d && !d.error ? d : null;
  const then = divider.get(it.id);
  const isNew = (x) => since(x.at, then) && !isMe(x.byId, data.me);
  const changed = new Set((p?.history ?? []).filter(isNew).map((e) => e.kind)); // what changed since you looked
  const rich = []; // html for the [data-rich] slots, made safe below
  const slot = (html) => `<div data-rich="${rich.push(html) - 1}"></div>`;
  const section = (title, body, cls = "") => (body ? `<section${cls ? ` class="${cls}"` : ""}><h3>${title}</h3>${body}</section>` : "");
  const editable = (action, html, kind, title) => `<span class="editable${changed.has(kind) ? " changed" : ""}" data-edit="${action}" title="${title}">${html}</span>`;
  const value = (f) => (f.format === "link" && /^https?:\/\//i.test(f.value) ? `<a class="link" data-href="${esc(f.value)}">${esc(f.value)}</a>`
    : EDITABLE[f.ref] ? editable(EDITABLE[f.ref], esc(valueText(f.value, f.format)), EDITABLE[f.ref], "Change it")
    : esc(valueText(f.value, f.format)));
  const fields = (list) => list.map((f) => `<dt>${esc(f.label)}</dt><dd>${value(f)}</dd>`).join("");

  // Its properties: the ones that change with a click first
  const tags = it.tags.map((t) => `<span class="td-badge">${esc(t)}</span>`).join(" ");
  const planning = (p?.planning ?? []).filter((f) => f.ref !== "Microsoft.VSTS.Common.Priority");
  const properties = `<dl class="fields props">
      <dt>State ${kbd("r")}</dt><dd>${editable("state", `<i class="dot ${stateClass(it.state)}"></i>${esc(it.state)}`, "state", "Change the state (r)")}${p?.reason ? ` <span class="td-muted">${esc(p.reason)}</span>` : ""}</dd>
      <dt>Assigned ${kbd("Space u")}</dt><dd>${editable("assign", esc(it.assignedTo || "Unassigned"), "assignee", "Assign it (Space u)")}</dd>
      <dt>Iteration ${kbd("Space m")}</dt><dd>${editable("iteration", esc(lastPart(it.iteration) || "—"), "iteration", `${esc(it.iteration)}: move it (Space m)`)}</dd>
      ${p?.area ? `<dt>Area</dt><dd${changed.has("area") ? ' class="changed"' : ""}>${esc(lastPart(p.area))}</dd>` : ""}
      <dt>Priority ${kbd("Space n")}</dt><dd>${editable("priority", esc(it.priority ?? "—"), "priority", "Change the priority (Space n)")}</dd>
      <dt>Tags ${kbd("Space g")}</dt><dd>${editable("tags", tags || `<span class="td-muted">+ add</span>`, "tags", "Edit the tags (Space g)")}</dd>
      ${fields(planning)}</dl>`;
  const development = `<ul class="links"><li class="link" data-edit="copy-branch" title="Copy it (yy)">⎇ <code>${esc(branchName(it, data.branchPrefix))}</code> <span class="td-muted">copy</span> ${kbd("yy")}</li>
    ${(p?.development ?? []).map((x) => `<li${x.url ? ` class="link" data-href="${esc(x.url)}"` : ""}><span class="td-muted">${esc(x.kind)}</span> ${esc(x.label)}</li>`).join("")}</ul>`;
  let side = section("Properties", properties) + section("Development", development);
  if (p) {
    const kinds = [...new Set(["Parent", "Child", ...p.related.map((r) => r.kind)])];
    side += section("Related work", kinds.map((k) => {
      const of = p.related.filter((r) => r.kind === k);
      return of.length ? `<h4>${esc(k)}</h4><ul class="links">${of.map((r) => `<li class="link" data-goto="${r.id}" data-url="${esc(r.url)}">
        <span class="type ${esc(r.type)}">${esc(r.type)}</span> <span class="id">${r.id}</span> <span class="title">${esc(r.title)}</span>
        <span class="state"><i class="dot ${stateClass(r.state)}"></i>${esc(r.state)}</span></li>`).join("")}</ul>` : "";
    }).join(""))
      + section("Links", p.links.length ? `<ul class="links">${p.links.map((l) => `<li class="link" data-href="${esc(l.url)}">${esc(l.label)}</li>`).join("")}</ul>` : "")
      + section("Attachments", p.attachments.length ? `<ul class="links">${p.attachments.map((f) => `<li class="link" data-href="${esc(f.url)}">${esc(f.name)} <span class="td-muted">${bytes(f.size)}</span></li>`).join("")}</ul>` : "")
      + section("Details", `<dl class="fields">${fields([...p.other, { label: "Project", value: it.project },
        ...(p.createdBy ? [{ label: "Created", value: `${p.createdBy} · ${valueText(p.created)}` }] : []),
        ...(p.changedBy ? [{ label: "Updated", value: `${p.changedBy} · ${ago(p.changed)}` }] : [])])}</dl>`);
  }

  // Its text, then its activity: comments and history, oldest first
  let main = d?.error ? `<p class="td-error">${esc(d.error)}</p>` : `<p class="td-muted">…</p>`;
  if (p) {
    const activity = [...p.history.map((e) => ({ ...e, comment: false })), ...p.comments.map((c) => ({ ...c, comment: true }))]
      .filter((x) => x.at).sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
    const firstNew = activity.findIndex(isNew);
    const old = firstNew < 0 ? activity.length : firstNew;
    const folded = old > 6 && !unfolded.has(it.id) ? old - 3 : 0; // the older ones, but the last 3 before what's new
    const entry = (x) => (x.comment
      ? `<li class="comment${isNew(x) ? " new" : ""}"><div class="by"><span class="avatar">${esc((x.by || "?")[0])}</span>${esc(x.by)} <span class="td-muted">${esc(ago(x.at))}</span></div>${slot(x.html)}</li>`
      : `<li class="event${isNew(x) ? " new" : ""}"><span class="who">${esc(x.by)}</span> ${eventText(x)} <span class="td-muted when">· ${esc(ago(x.at))}</span></li>`);
    main = (p.rich.length ? p.rich.map((r) => section(esc(r.label), `<div class="text" data-field="${esc(r.label)}">${slot(r.html)}</div>`)).join("")
      : section("Description", `<p class="td-muted">No description.</p>`))
      + (p.worklog ? workLogSection(p.worklog, section) : "")
      + section(`Activity <span class="td-muted">${p.comments.length ? `${p.comments.length} comment${p.comments.length > 1 ? "s" : ""}` : ""}</span>`, `<ol class="activity">
        ${folded ? `<li class="more"><button data-unfold="${it.id}">Show ${folded} earlier</button></li>` : ""}
        ${activity.map((x, n) => (n < folded ? "" : (n === firstNew ? `<li class="divider"><span>New since you last looked</span></li>` : "") + entry(x))).join("")}
      </ol>
      <div class="composer"><textarea id="compose" rows="3" placeholder="Write a comment… (Markdown works · Ctrl+Enter: send)"></textarea>
        <div class="buttons"><span class="td-muted">${kbd("cc")} here · ${kbd("Esc")} leave</span><button id="compose-send">Comment ${kbd("Ctrl+Enter")}</button></div></div>`, "activity-section");
  }

  const typing = document.activeElement?.id === "compose" ? [$("compose").selectionStart, $("compose").selectionEnd] : null;
  const leaving = mode === "page" ? `<button class="back" data-back title="Back (Esc)">‹ ${esc(backName())} ${kbd("Esc")}</button>` : "";
  box.innerHTML = `<header class="head"><i class="bar ${esc(it.type)}"></i>
      <div class="top">${leaving}<span class="kind"><span class="type ${esc(it.type)}">${esc(it.type.toUpperCase())}</span> ${it.id}</span>
        ${editable("state", `<i class="dot ${stateClass(it.state)}"></i>${esc(it.state)}`, "state", "Change the state (r)")} ${kbd("r")}
        <span class="spacer"></span>
        <button data-edit="outside" title="Open it in Azure DevOps (gx)">Open ↗ ${kbd("gx")}</button><button data-edit="copy-ref" title="${esc(`Copy “${reference(it)}” (Space y r)`)}">Copy ${kbd("Space y r")}</button></div>
      <h2>${editable("title", esc(it.title), "title", "Edit the title (i)")} ${kbd("i")}</h2></header>
    <div class="cols"><div class="main">${main}</div><aside>${side}</aside></div>`;
  for (const el of box.querySelectorAll("[data-rich]")) el.replaceWith(safe(rich[el.dataset.rich]));
  fold(box);
  pictures(box, it.id);
  const compose = $("compose");
  if (compose) {
    compose.value = drafts.get(it.id) ?? "";
    if (typing) {
      compose.focus();
      compose.setSelectionRange(...typing);
    }
  }
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

/** The work log (the Hours field setting's) as a table: day, activity, hours, the total; each
 *  entry changed or removed with a click, time logged with L */
function workLogSection(wl, section) {
  const day = (k) => (k ? new Date(`${k}T12:00:00`).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short", year: "numeric" }) : "—");
  const body = wl.error ? `<p class="td-error">${esc(wl.error)}</p>`
    : (wl.rows.length ? `<table class="worklog"><thead><tr><th>Day</th>${wl.activity ? "<th>Activity</th>" : ""}<th class="h">Hours</th><th></th></tr></thead><tbody>
        ${wl.rows.map((r) => `<tr><td>${esc(day(r.day))}</td>${wl.activity ? `<td>${esc(r.activity)}</td>` : ""}<td class="h">${hoursText(r.hours)}</td>
          <td class="do"><button data-log-change="${r.n}" title="Change it">Change</button><button data-log-remove="${r.n}" title="Remove it">✕</button></td></tr>`).join("")}</tbody>
        <tfoot><tr><td${wl.activity ? ' colspan="2"' : ""}>Total</td><td class="h">${hoursText(wl.total)}</td><td></td></tr></tfoot></table>`
      : `<p class="td-muted">No time logged on it yet.</p>`)
      + `<p><button data-edit="log" title="Log time on it (Space l)">Log time ${kbd("Space l")}</button></p>`;
  return section(`Work log <span class="td-muted">${hoursText(wl.total)}</span>`, body, "worklog-section");
}

// A long text (over about 10 lines; a bit over isn't worth it) shows its start, and "Show all";
// the fields you open stay open, on every work item (kept)
const FOLD_AT = 190;
let openFields = new Set();

function fold(box) {
  for (const t of box.querySelectorAll(".text[data-field]")) {
    const full = t.scrollHeight;
    if (full <= FOLD_AT * 1.4) continue;
    const open = openFields.has(t.dataset.field);
    t.classList.toggle("folded", !open);
    t.insertAdjacentHTML("afterend", `<button class="fold" data-fold="${esc(t.dataset.field)}">${open ? "Show less" : `Show all (${Math.round(full / 19)} lines)`} ${kbd(open ? "zM" : "zR")}</button>`);
  }
}

/** Opens or folds a long text (field: its name; none: all of the page's, opened if one is folded) */
function foldText(field) {
  const all = [...document.querySelectorAll("#detail [data-fold]")].map((b) => b.dataset.fold);
  if (!all.length) return;
  const fields = field ? [field] : all;
  const open = field ? !openFields.has(field) : all.some((f) => !openFields.has(f));
  for (const f of fields) open ? openFields.add(f) : openFields.delete(f);
  td.storage.set("openFields", [...openFields]).catch(() => {});
  detail();
}

/** Sends the comment being written on a work item */
async function sendComment(it) {
  const typed = (drafts.get(it.id) ?? "").trim();
  if (!typed) return td.ui.say("write the comment first", { error: true });
  try {
    const { error } = await td.backend.call("comment", { id: it.id, text: typed });
    if (error) throw new Error(error);
    drafts.delete(it.id);
    fresh.delete(it.id);
    $("compose")?.blur();
    td.ui.say(`commented on ${it.type} ${it.id}`);
  } catch (e) {
    td.ui.say(e.message, { error: true });
  }
  await load();
}

// When you last looked at each work item's page (kept, per organization): what's new is after it
let seen = {};
let seenKey = "";
let saving = null;
const divider = new Map(); // id -> when you'd looked before, while its page is open: its new things are after it
const unfolded = new Set(); // ids whose whole activity shows
const drafts = new Map(); // id -> the comment being written

let looking = null; // the work item whose page is open, for "last looked"

/** Opening a work item's page: what's new on it is after when you last looked; you look now */
function lookingAt(it) {
  if (it?.id === looking) return;
  if (looking) markSeen(looking);
  looking = it?.id ?? null;
  if (!it) return;
  divider.set(it.id, seen[it.id] ?? it.changed);
  markSeen(it.id);
}

function markSeen(id) {
  seen[id] = new Date().toISOString();
  clearTimeout(saving);
  saving = setTimeout(() => td.storage.set(seenKey, seen).catch(() => {}), 1000);
}

/** After a look: the organization's "last looked", and a start for the work items without one
 *  (what was there before isn't news) */
async function seenFor(items) {
  const key = `seen ${data.org ?? ""}`;
  if (key !== seenKey) {
    seenKey = key;
    seen = (await td.storage.get(key).catch(() => null)) ?? {};
  }
  const ids = new Set(items.map((i) => String(i.id)));
  for (const id of Object.keys(seen)) if (!ids.has(id)) delete seen[id];
  for (const i of items) seen[i.id] ??= i.changed || new Date().toISOString();
  if (looking) seen[looking] = new Date().toISOString();
  td.storage.set(seenKey, seen).catch(() => {});
}
/** Something new on it since you last looked (not by you) */
const unseen = (i) => since(i.changed, seen[i.id]) && !isMe(i.changedBy, data.me);

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

/** Asks for a value in the view's own box: choices to pick from (typing narrows them), and/or
 *  free text. Its answer, or null (Esc). */
function ask({ label, value = "", choices = null, free = !choices, hint = "" }) {
  const box = $("ask");
  const field = $("ask-input");
  $("ask-label").textContent = label;
  $("ask-ok").hidden = !!choices && !free; // picking a choice is the saving
  $("ask-hint").textContent = hint || (choices ? `↑↓ pick · Enter${free ? " (or what you typed)" : ""} · Esc: cancel` : "Enter: save · Esc: cancel");
  box.hidden = false;
  field.value = value;
  let at = 0;
  const matching = () => {
    const w = field.value.trim().toLowerCase();
    return (choices ?? []).filter((c) => !w || field.value === value || `${c.label} ${c.note ?? ""}`.toLowerCase().includes(w));
  };
  const draw = () => {
    const list = matching();
    at = Math.max(0, Math.min(at, list.length - 1));
    $("ask-choices").innerHTML = list.map((c, n) => `<li class="${n === at ? "cursor" : ""}" data-pick="${n}">${esc(c.label)}${c.note && c.note !== c.label ? ` <span class="td-muted">${esc(c.note)}</span>` : ""}</li>`).join("");
    $("ask-choices").querySelector(".cursor")?.scrollIntoView({ block: "nearest" });
  };
  draw();
  field.focus();
  field.select();
  return new Promise((resolve) => {
    const done = (answer) => {
      box.hidden = true;
      field.removeEventListener("keydown", key);
      field.removeEventListener("input", typed);
      field.removeEventListener("blur", left);
      $("ask-choices").onmousedown = null;
      box.onmousedown = $("ask-ok").onmousedown = $("ask-cancel").onmousedown = null;
      field.blur();
      td.keys.take();
      resolve(answer);
    };
    const pick = () => {
      const list = matching();
      if (list[at]) return done(list[at].value);
      if (free) return done(field.value);
    };
    const key = (e) => {
      if (e.key === "Escape") return e.preventDefault(), done(null);
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        at += e.key === "ArrowDown" ? 1 : -1;
        return draw();
      }
      if (e.key === "Enter") return e.preventDefault(), pick();
    };
    const typed = () => ((at = 0), draw());
    const left = () => setTimeout(() => !box.hidden && document.activeElement !== field && done(null), 150);
    field.addEventListener("keydown", key);
    field.addEventListener("input", typed);
    field.addEventListener("blur", left);
    box.onmousedown = (e) => e.target !== field && e.preventDefault(); // a click in the box keeps the field (its blur would cancel)
    $("ask-ok").onmousedown = (e) => {
      e.preventDefault();
      if (free && !choices) done(field.value);
      else pick();
    };
    $("ask-cancel").onmousedown = (e) => {
      e.preventDefault();
      done(null);
    };
    $("ask-choices").onmousedown = (e) => {
      const li = e.target.closest("[data-pick]");
      if (!li) return;
      e.preventDefault();
      at = Number(li.dataset.pick);
      pick();
    };
  });
}

/** Changes a work item (backend.js change): the list and its page follow */
async function change(it, set, said) {
  try {
    const { error } = await td.backend.call("change", { id: it.id, set });
    if (error) throw new Error(error);
    fresh.delete(it.id);
    td.ui.say(`${it.type} ${it.id}: ${said}`);
  } catch (e) {
    td.ui.say(e.message, { error: true });
  }
  await load();
}

async function options(it, field) {
  try {
    return await td.backend.call("options", { id: it.id, field });
  } catch (e) {
    td.ui.say(e.message, { error: true });
    return null;
  }
}

/** The changes, one per key */
const edits = {
  async state(it) {
    const choices = await options(it, "state");
    const to = choices && (await ask({ label: `State of ${it.type} ${it.id} (now ${it.state})`, choices: choices.filter((c) => c.value !== it.state) }));
    if (to) await change(it, { state: to }, `state → ${to}`);
  },
  async assign(it) {
    const choices = await options(it, "assignee");
    if (!choices) return;
    const to = await ask({ label: `Assign ${it.type} ${it.id} (now ${it.assignedTo || "nobody"}) to…`, choices, free: true, hint: "↑↓ pick · or type an email · Enter · Esc: cancel" });
    if (to !== null) await change(it, { assignee: to }, to ? `assigned to ${choices.find((c) => c.value === to)?.label ?? to}` : "unassigned");
  },
  /** The comment box at the end of its activity */
  async comment() {
    const box = $("compose");
    if (!box) return td.ui.say("its page is still loading", { error: true });
    box.scrollIntoView({ block: "center" });
    box.focus();
  },
  async title(it) {
    const to = (await ask({ label: `Title of ${it.type} ${it.id}`, value: it.title }))?.trim();
    if (to && to !== it.title) await change(it, { title: to }, "title changed");
  },
  async tags(it) {
    const typed = await ask({ label: `Tags of ${it.type} ${it.id} (separated by ;)`, value: it.tags.join("; ") });
    if (typed === null) return;
    const to = typed.split(/[;,]/).map((t) => t.trim()).filter(Boolean);
    if (to.join(";") !== it.tags.join(";")) await change(it, { tags: to }, to.length ? `tags: ${to.join(", ")}` : "no tags");
  },
  async priority(it) {
    const to = await ask({ label: `Priority of ${it.type} ${it.id}${it.priority ? ` (now ${it.priority})` : ""}`,
      choices: [1, 2, 3, 4].map((n) => ({ value: String(n), label: String(n), note: ["", "highest", "", "", "lowest"][n] })) });
    if (to) await change(it, { priority: Number(to) }, `priority ${to}`);
  },
  async iteration(it) {
    const choices = await options(it, "iteration");
    const to = choices && (await ask({ label: `Move ${it.type} ${it.id} (now ${it.iteration}) to…`, choices: choices.filter((c) => c.value !== it.iteration) }));
    if (to) await change(it, { iteration: to }, `moved to ${to.split("\\").pop()}`);
  },
  /** Time in its work log: a new entry, or one of them changed or removed */
  async log(it) {
    const wl = workLogOf(it);
    if (!wl) return;
    if (!wl.rows.length) return logEntry(it, wl);
    const choices = [{ value: "new", label: "Log time", note: `a new entry (${logDay()})` },
      ...wl.rows.flatMap((r) => [{ value: `change ${r.n}`, label: `Change ${entryText(r)}` }, { value: `remove ${r.n}`, label: `Remove ${entryText(r)}` }])];
    const to = await ask({ label: `The work log of ${it.type} ${it.id}`, choices });
    if (!to) return;
    const [what, n] = to.split(" ");
    if (what === "new") return logEntry(it, wl);
    const row = wl.rows.find((r) => r.n === Number(n));
    return what === "change" ? logEntry(it, wl, row) : removeEntry(it, row);
  },
};

// Logging time (a work log Hours field): the day, the hours, the activity; written by the backend
/** The work log on its page, or why there's none (said) */
function workLogOf(it) {
  const d = details.get(it.id);
  if (!d || d.error) return td.ui.say(d?.error || "its page is still loading", { error: true }), null;
  if (!d.worklog) return td.ui.say("The Hours field isn't a work log: set it in Settings › Plugins › Azure Boards (e.g. Custom.WorkLogData | date: startDate | amount: daysSpent)", { error: true }), null;
  if (d.worklog.error) return td.ui.say(d.worklog.error, { error: true }), null;
  return d.worklog;
}
const entryText = (r) => [r.day, r.activity, hoursText(r.hours)].filter(Boolean).join(" · ");
/** The day a new entry is for: the calendar's selected day if its page was opened from there, or today */
const logDay = () => (mode === "page" && opened?.day) || dayKey(new Date());

/** A new entry (row: none), or a change to one: asks its day, hours and activity */
async function logEntry(it, wl, row = null) {
  const doing = row ? `Change ${entryText(row)} on ${it.type} ${it.id}` : `Log time on ${it.type} ${it.id}`;
  const day = (await ask({ label: `${doing}: the day (YYYY-MM-DD)`, value: row?.day || logDay() }))?.trim();
  if (!day) return;
  if (!/^\d{4}-\d\d-\d\d$/.test(day) || Number.isNaN(Date.parse(day))) return td.ui.say("the day: YYYY-MM-DD, e.g. 2026-10-15", { error: true });
  const typed = (await ask({ label: `${doing}: the hours on ${day}`, value: row ? String(row.hours) : "" }))?.trim();
  if (!typed) return;
  const hours = Number(typed.replace(",", "."));
  if (!Number.isFinite(hours) || hours <= 0) return td.ui.say("the hours: a number over 0, e.g. 1.5", { error: true });
  let activity = row?.activity ?? "";
  if (wl.activity) {
    const known = [...new Set([...(row?.activity ? [row.activity] : []), ...wl.activities])];
    const picked = await ask({ label: `${doing}: the activity`, value: activity, choices: known.map((a) => ({ value: a, label: a })), free: true,
      hint: "↑↓ pick · or type one · Enter · Esc: cancel" });
    if (picked === null) return;
    activity = picked.trim();
  }
  const to = { day, hours, activity };
  await writeLog(it, row ? { change: row.n, to, was: row.key } : { add: to }, `${row ? "changed" : "logged"} ${hoursText(hours)} on ${day}`);
}

async function removeEntry(it, row) {
  if (!row) return;
  const sure = await ask({ label: `Remove ${entryText(row)} from the work log of ${it.type} ${it.id}?`, choices: [{ value: "yes", label: "Remove it" }, { value: "no", label: "Keep it" }] });
  if (sure === "yes") await writeLog(it, { remove: row.n, was: row.key }, `removed ${entryText(row)}`);
}

/** The change written (backend.js logTime); its page and the calendar follow */
async function writeLog(it, what, said) {
  try {
    const { error } = await td.backend.call("logTime", { id: it.id, change: what });
    if (error) throw new Error(error);
    td.ui.say(`${it.type} ${it.id}: ${said}`);
  } catch (e) {
    td.ui.say(e.message, { error: true });
  }
  fresh.delete(it.id);
  logged.since = ""; // the calendar's numbers asked again
  await load();
}

/** Only the current sprint's, or every iteration's */
async function toggleSprint() {
  const { sprintOnly: on } = await td.backend.call("sprint", { on: !data.sprintOnly });
  td.ui.say(on ? "only the current sprint's" : "every iteration's");
  await load();
}

// The hours calendar: a month, the hours you logged on each day (hours.js), the highlighted
// day's work items and its week's beside it
let mode = "list"; // or "hours" (kept); "page": one work item's page, "search": a search's results
let day = new Date(); // the highlighted day
let logged = { since: "", entries: [], perDay: 8, note: "", error: "" }; // backend.js hours
let loggedDays = new Map();
let hoursAsked = ""; // the since asked for (a newer answer wins)
const DAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());

/** Shows the list, the calendar, a page or a search. Going to the list or the calendar yourself
 *  (w, not back): where you came from is forgotten */
function setMode(to, { back = false } = {}) {
  if (!back && (to === "list" || to === "hours")) cameFrom.length = 0;
  mode = to;
  if (mode === "list" || mode === "hours") td.storage.set("mode", mode).catch(() => {});
  $("hours").hidden = mode !== "hours";
  $("search").hidden = mode !== "search";
  document.querySelector("main").hidden = mode !== "list" && mode !== "page";
  document.querySelector("main").classList.toggle("page", mode === "page");
  $("hours-toggle").classList.toggle("on", mode === "hours");
  $("hours-toggle").title = mode === "hours" ? "Back to the work items (w)" : "The hours you logged, day by day (w)";
  td.keys.use(mode === "page" ? "page" : mode === "search" ? "search" : "view");
  render();
  if (mode === "hours") loadHours();
  if (mode === "search") renderSearch();
}

// A work item's page on its own (one that isn't in the list, or opened from the calendar or a
// search), and where you came from: Esc goes back there, the cursor where it was
let opened = null; // { id, stub (what's known of it before its page comes), day (the calendar's, opened from there) }
const cameFrom = []; // [{ mode, opened }]
/** What's known of a work item before its page comes (the list's, the calendar's, a search's, a related one's) */
function stub(id) {
  const known = data.items.find((i) => i.id === id) ?? found.items.find((i) => i.id === id) ?? logged.entries.find((e) => e.id === id)
    ?? [...details.values()].flatMap((d) => d.related ?? []).find((r) => r.id === id) ?? {};
  return { id, type: known.type ?? "", title: known.title || "…", state: known.state ?? "", assignedTo: known.assignedTo ?? "", iteration: known.iteration ?? "",
    priority: known.priority ?? null, tags: known.tags ?? [], project: known.project ?? "", url: known.url ?? "", changed: known.changed ?? "" };
}
/** The opened work item: as its page has it, else the list's, else what was known */
const pageItem = () => opened && (details.get(opened.id)?.item ?? data.items.find((i) => i.id === opened.id) ?? opened.stub);
const backName = () => ({ list: "Work items", hours: "Hours", search: "Search", page: "Back" })[cameFrom.at(-1)?.mode] ?? "Work items";

/** Opens a work item's page: in the list, there (from the list); else on its own */
function openItem(id) {
  if (!Number.isInteger(id)) return;
  if (mode === "list" && select(id)) return;
  cameFrom.push({ mode, opened });
  opened = { id, stub: stub(id), day: mode === "hours" ? dayKey(day) : mode === "page" ? opened?.day ?? null : null };
  setMode("page");
  $("detail").scrollTop = 0;
}

/** Back where you came from (the calendar, the search, the list, the page before) */
function goBack() {
  const to = cameFrom.pop() ?? { mode: "list", opened: null };
  opened = to.opened;
  setMode(to.mode, { back: true });
}

// A search, as Azure DevOps' own (F): a number opens that work item; words list the work items
// whose title has them all, anyone's, in any state
let found = { typed: "", items: [], error: "", asking: false };
let foundAt = 0;

async function search() {
  if (!$("ask").hidden) return;
  const typed = (await ask({ label: "Search work items: a number, or words in their title", value: found.typed, hint: "Enter: search · Esc: cancel" }))?.trim();
  if (!typed) return;
  if (/^#?\d+$/.test(typed)) return openItem(Number(typed.replace("#", "")));
  if (mode !== "search") cameFrom.push({ mode, opened });
  found = { typed, items: [], error: "", asking: true };
  foundAt = 0;
  setMode("search");
  const got = await td.backend.call("search", { text: typed }).catch((e) => ({ items: [], error: e.message }));
  if (found.typed !== typed) return;
  found = { typed, ...got, asking: false };
  renderSearch();
}

function renderSearch() {
  if (mode !== "search") return;
  const f = found;
  foundAt = Math.max(0, Math.min(foundAt, f.items.length - 1));
  $("search").innerHTML = `<header class="search-head"><button class="back" data-back title="Back (Esc)">‹ ${esc(backName())} ${kbd("Esc")}</button>
      <h2>“${esc(f.typed)}”</h2><span class="td-muted">${f.asking ? "Asking Azure DevOps…" : `${f.items.length}${f.items.length >= 50 ? " (the 50 most recently changed)" : ""} found`}</span>
      <span class="spacer"></span><button data-edit="search" title="Another search (Space /)">Search ${kbd("Space /")}</button></header>
    ${f.error ? `<p class="td-error">${esc(f.error)}</p>` : ""}
    <table class="found"><tbody>${f.items.map((i, n) => `<tr class="${n === foundAt ? "cursor" : ""}" data-found="${n}" title="${esc(`${i.type} ${i.id} · ${i.state}\n${i.title}`)}">
      <td class="type ${esc(i.type)}"><span class="mark">${mark(i.type)}</span> ${esc(i.type)}</td><td class="id">${i.id}</td><td class="title">${esc(i.title)}</td>
      <td class="state"><i class="dot ${stateClass(i.state)}"></i>${esc(i.state)}</td><td class="who">${esc(i.assignedTo || "Unassigned")}</td></tr>`).join("")}</tbody></table>
    ${!f.asking && !f.error && !f.items.length ? `<p class="td-muted">No work item's title has all of these words.</p>` : ""}
    <p class="td-muted keys">${kbd("j")}${kbd("k")} move · ${kbd("Enter")} its page · ${kbd("gx")} in Azure DevOps · ${kbd("Space /")} search again · ${kbd("Esc")} back</p>`;
  $("search").querySelector(".cursor")?.scrollIntoView({ block: "nearest" });
}

/** What a key does on the search's results */
function actSearch(action) {
  const it = found.items[foundAt];
  const to = (n) => ((foundAt = Math.max(0, Math.min(found.items.length - 1, n))), renderSearch());
  switch (action) {
    case "down": return to(foundAt + 1);
    case "up": return to(foundAt - 1);
    case "first": return to(0);
    case "last": return to(found.items.length - 1);
    case "open": return it && openItem(it.id);
    case "outside": return it && td.ui.openUrl(it.url);
    case "search": return search();
    case "refresh": {
      const typed = found.typed;
      found = { ...found, asking: true };
      renderSearch();
      return td.backend.call("search", { text: typed }).catch((e) => ({ items: [], error: e.message }))
        .then((got) => found.typed === typed && ((found = { typed, ...got, asking: false }), renderSearch()));
    }
    case "hours": return setMode("hours");
    case "leave": return goBack();
  }
}

/** What a key does on a work item's page of its own */
function actPage(action) {
  const it = pageItem();
  const box = $("detail");
  switch (action) {
    case "down": return box.scrollBy({ top: 60 });
    case "up": return box.scrollBy({ top: -60 });
    case "first": return box.scrollTo({ top: 0 });
    case "last": return box.scrollTo({ top: box.scrollHeight });
    case "page-down": return box.scrollBy({ top: box.clientHeight * 0.8 });
    case "page-up": return box.scrollBy({ top: -box.clientHeight * 0.8 });
    case "outside": return it?.url && td.ui.openUrl(it.url);
    case "copy-branch": return it && copy(branchName(it, data.branchPrefix), "the branch name");
    case "copy-ref": return it && copy(reference(it), `${it.type} ${it.id}`);
    case "fold": return foldText();
    case "search": return search();
    case "hours": return setMode("hours");
    case "leave": return goBack();
    case "state": case "assign": case "comment": case "title": case "tags": case "priority": case "iteration": case "log":
      return it && $("ask").hidden && (details.get(it.id)?.item || action === "comment" || action === "log" ? edits[action](it) : td.ui.say("its page is still loading", { error: true }));
    case "refresh":
      if (it) fresh.delete(it.id);
      td.ui.say("looking again…");
      return detail();
  }
}

/** Asks for the hours of the highlighted day's month (and the days around it) */
async function loadHours() {
  const since = dayKey(weeks(day.getFullYear(), day.getMonth())[0][0]);
  hoursAsked = since;
  if (logged.since !== since) renderHours();
  const got = await td.backend.call("hours", { since }).catch((e) => ({ entries: [], perDay: 8, note: "", error: e.message }));
  if (hoursAsked !== since) return;
  logged = { ...got, since };
  loggedDays = byDay(logged.entries);
  renderHours();
}

function moveDay(to) {
  const was = day.getMonth();
  day = startOfDay(to);
  renderHours();
  if (day.getMonth() !== was) loadHours();
}

/** A month on, or back (the same day, or its last) */
function moveMonth(by) {
  const last = new Date(day.getFullYear(), day.getMonth() + by + 1, 0).getDate();
  moveDay(new Date(day.getFullYear(), day.getMonth() + by, Math.min(day.getDate(), last)));
}

function renderHours() {
  if (mode !== "hours") return;
  const year = day.getFullYear();
  const month = day.getMonth();
  const today = startOfDay(new Date());
  const per = logged.perDay || 8;
  const loading = logged.since !== hoursAsked;
  const hoursOn = (d) => (loading ? 0 : loggedDays.get(dayKey(d))?.hours ?? 0);
  const working = (d) => d.getDay() !== 0 && d.getDay() !== 6;
  const all = weeks(year, month);
  const inMonth = all.flat().filter((d) => d.getMonth() === month);
  const total = inMonth.reduce((n, d) => n + hoursOn(d), 0);
  const workedDays = inMonth.filter((d) => hoursOn(d) > 0).length;
  // A day's work items in it, when it's tall enough (view.css)
  const mini = (d) => {
    const items = loading ? [] : loggedDays.get(dayKey(d))?.items ?? [];
    return items.length ? `<ul class="mini">${items.map((i) => `<li title="${esc(`${i.type} ${i.id} · ${hoursText(i.hours)}\n${i.title}`)}"><span class="mark ${esc(i.type)}">${mark(i.type)}</span><span class="id">${i.id}</span><span class="title">${esc(i.title)}</span><b>${hoursText(i.hours)}</b></li>`).join("")}</ul>` : "";
  };
  const cell = (d) => {
    const h = hoursOn(d);
    const cls = ["cell", d.getMonth() !== month && "out", !working(d) && "weekend", +d === +today && "today", d > today && "future",
      +d === +startOfDay(day) && "cursor", h >= per ? "full" : h > 0 ? "short" : ""].filter(Boolean).join(" ");
    return `<div class="${cls}" data-day="${dayKey(d)}" title="${esc(`${d.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" })}: ${hoursText(h)}`)}">
      <span class="n">${d.getDate()}</span>${mini(d)}${h ? `<span class="h">${hoursText(h)}</span>` : ""}
      <i class="fill" style="width:${Math.min(100, (h / per) * 100)}%"></i></div>`;
  };
  const week = (w) => {
    const h = w.reduce((n, d) => n + hoursOn(d), 0);
    const target = w.filter(working).length * per;
    return `<div class="week${h >= target ? " full" : ""}"><span class="h">${h ? hoursText(h) : "—"}</span><span class="td-muted">of ${target}h</span></div>`;
  };

  // The highlighted day: its work items; its week's, each with its hours
  const it = (i, max) => `<li class="link" data-goto="${i.id}" data-url="${esc(i.url)}" title="${esc(`${i.type} ${i.id} · ${i.state}\n${i.title}`)}">
      <span class="mark ${esc(i.type)}">${mark(i.type)}</span><span class="id">${i.id}</span><span class="title">${esc(i.title)}</span>
      <span class="h">${hoursText(i.hours)}</span><i class="fill" style="width:${max ? (i.hours / max) * 100 : 0}%"></i></li>`;
  const list = (items) => {
    const max = Math.max(0, ...items.map((i) => i.hours));
    return items.length ? `<ul class="logged">${items.map((i) => it(i, max)).join("")}</ul>` : "";
  };
  const picked = loading ? null : loggedDays.get(dayKey(day));
  const thisWeek = all.find((w) => w.some((d) => +d === +startOfDay(day))) ?? [];
  const weekItems = new Map();
  for (const d of thisWeek) {
    for (const i of (loading ? null : loggedDays.get(dayKey(d)))?.items ?? []) {
      const was = weekItems.get(i.id);
      weekItems.set(i.id, { ...i, hours: (was?.hours ?? 0) + i.hours });
    }
  }
  const weekList = [...weekItems.values()].filter((i) => Math.abs(i.hours) > 0.001).sort((a, b) => b.hours - a.hours);
  const weekTotal = thisWeek.reduce((n, d) => n + hoursOn(d), 0);
  const dayName = day.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" });

  $("hours").innerHTML = `<div class="calendar">
      <header class="cal-head">
        <button data-month="-1" title="The month before (Ctrl+u)">‹ ${kbd("Ctrl+u")}</button>
        <h2>${esc(day.toLocaleDateString(undefined, { month: "long", year: "numeric" }))}</h2>
        <button data-month="1" title="The month after (Ctrl+d)">${kbd("Ctrl+d")} ›</button>
        <button data-today title="Today (gg)">Today ${kbd("gg")}</button>
        <span class="spacer"></span>
        <span class="td-muted">${loading ? "Asking Azure DevOps…" : `<b>${hoursText(total)}</b> logged${workedDays ? ` · ${hoursText(total / workedDays)} a day you logged` : ""}`}</span>
      </header>
      ${logged.error && !loading ? `<p class="td-error">${esc(logged.error)}</p>` : ""}
      ${logged.note && !loading ? `<p class="td-muted">${esc(logged.note)}</p>` : ""}
      <div class="grid" style="grid-template-rows: auto repeat(${all.length}, minmax(58px, 1fr))">${[...DAY_NAMES, "Week"].map((n) => `<div class="name">${n}</div>`).join("")}
        ${all.map((w) => w.map(cell).join("") + week(w)).join("")}</div>
      <p class="td-muted keys">${kbd("h")}${kbd("l")} day · ${kbd("j")}${kbd("k")} week · ${kbd("Ctrl+d")}${kbd("Ctrl+u")} month · ${kbd("Space c")} back to the work items</p>
    </div>
    <aside class="day">
      <h3>${esc(dayName)}</h3>
      <p class="total"><b>${hoursText(picked?.hours ?? 0)}</b> <span class="td-muted">of ${per}h</span></p>
      ${loading ? `<p class="td-muted">…</p>` : list(picked?.items ?? []) || `<p class="td-muted">${day > today ? "Not yet." : "Nothing logged."}</p>`}
      <h3>Its week <span class="td-muted">${hoursText(weekTotal)}</span></h3>
      ${loading ? "" : list(weekList) || `<p class="td-muted">Nothing logged.</p>`}
      <p class="td-muted note">What you added to a work item's completed work, counted on the day you added it (in a work log: on its entry's day). A click: its page.</p>
    </aside>`;
}

/** What a key does on the calendar */
function actHours(action) {
  const by = (n) => moveDay(new Date(day.getFullYear(), day.getMonth(), day.getDate() + n));
  switch (action) {
    case "open": return by(1);
    case "close": return by(-1);
    case "down": return by(7);
    case "up": return by(-7);
    case "first": return moveDay(new Date());
    case "last": return moveDay(new Date(day.getFullYear(), day.getMonth() + 1, 0));
    case "page-down": return moveMonth(1);
    case "page-up": return moveMonth(-1);
    case "hours": return setMode("list");
    case "search": return search();
    case "refresh":
      td.ui.say("looking again…");
      logged.since = "";
      return loadHours();
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

// The keys (vim's names, plugin API 2) for the actions as this view calls them
const ALIAS = { yank: "copy-branch", search: "filter", "search-wide": "search", replace: "state", change: "comment", edit: "title", "unfold-all": "fold", "fold-all": "fold" };
td.on("key", ({ action }) => act(ALIAS[action] ?? action));

/** What a key or a button does */
function act(action) {
  if (mode === "hours") return actHours(action);
  if (mode === "search") return actSearch(action);
  if (mode === "page") return actPage(action);
  if (action === "hours") return setMode("hours");
  if (action === "search") return search();
  const row = shown()[cursor];
  const it = row?.it;
  switch (action) {
    case "down": return move(cursor + 1);
    case "up": return move(cursor - 1);
    case "first": return move(0);
    case "last": return move(shown().length - 1);
    case "outside": return it && td.ui.openUrl(it.url);
    case "copy-branch": return it && copy(branchName(it, data.branchPrefix), "the branch name");
    case "copy-ref": return it && copy(reference(it), `${it.type} ${it.id}`);
    case "fold-toggle": // its children shown / hidden
      if (row?.kids) return toggle(it.id, !row.open);
      return;
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
    case "fold": return foldText();
    case "sprint": return toggleSprint();
    case "state": case "assign": case "comment": case "title": case "tags": case "priority": case "iteration": case "log":
      return it && $("ask").hidden && edits[action](it);
    case "refresh":
      fresh.clear();
      td.ui.say("looking again…");
      return td.backend.call("refresh").then(load);
  }
}
// The comment box: kept while you write (a look again redraws the page), Ctrl+Enter sends
document.addEventListener("input", (e) => e.target.id === "compose" && showing && drafts.set(showing, e.target.value));
document.addEventListener("keydown", (e) => {
  if (e.target.id !== "compose") return;
  if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    if (showingItem()) sendComment(showingItem());
  } else if (e.key === "Escape") {
    e.target.blur();
    td.keys.take();
  }
});
td.backend.on("updated", () => {
  fresh.clear();
  load();
  if (mode === "hours") loadHours();
});
document.addEventListener("click", (e) => {
  if (e.target.closest("#refresh")) return td.backend.call("refresh").then(load);
  if (e.target.closest("#search-button")) return search();
  if (e.target.closest("#sprint")) return toggleSprint();
  if (e.target.closest("#hours-toggle")) return setMode(mode === "hours" ? "list" : "hours");
  const month = e.target.closest("[data-month]");
  if (month) return moveMonth(Number(month.dataset.month));
  if (e.target.closest("[data-today]")) return moveDay(new Date());
  const cell = e.target.closest("[data-day]");
  if (cell) {
    const [y, m, d] = cell.dataset.day.split("-").map(Number);
    return moveDay(new Date(y, m - 1, d));
  }
  if (e.target.closest("#compose-send")) return showingItem() && sendComment(showingItem());
  if (e.target.closest("[data-back]")) return goBack();
  const logChange = e.target.closest("[data-log-change], [data-log-remove]");
  if (logChange) {
    const it = showingItem();
    const wl = it && workLogOf(it);
    const n = Number(logChange.dataset.logChange ?? logChange.dataset.logRemove);
    const row = wl?.rows.find((r) => r.n === n);
    if (!row || !$("ask").hidden) return;
    return logChange.dataset.logChange != null ? logEntry(it, wl, row) : removeEntry(it, row);
  }
  const result = e.target.closest("[data-found]");
  if (result) {
    foundAt = Number(result.dataset.found);
    return openItem(found.items[foundAt]?.id);
  }
  const folding = e.target.closest("[data-fold]");
  if (folding) return foldText(folding.dataset.fold);
  const earlier = e.target.closest("[data-unfold]");
  if (earlier) {
    unfolded.add(Number(earlier.dataset.unfold));
    return detail();
  }
  const button = e.target.closest("[data-edit]");
  if (button) return act(button.dataset.edit);
  const link = e.target.closest("[data-href]");
  if (link) {
    // A link to a work item (#123): its page, here
    const href = String(link.dataset.href);
    const wi = !!data.orgUrl && href.toLowerCase().startsWith(`${data.orgUrl.toLowerCase()}/`) && href.match(/\/_workitems\/edit\/(\d+)(?:[/?#]|$)/i);
    return wi ? openItem(Number(wi[1])) : td.ui.openUrl(link.dataset.href);
  }
  const go = e.target.closest("[data-goto]");
  if (go) return openItem(Number(go.dataset.goto));
  const t = e.target.closest("[data-toggle]");
  if (t && !words) return toggle(Number(t.dataset.toggle));
  const row = e.target.closest("[data-n]");
  if (row) move(Number(row.dataset.n));
});
document.addEventListener("dblclick", (e) => e.target.closest("[data-n]") && !e.target.closest("[data-toggle]") && current() && td.ui.openUrl(current().url));
setInterval(render, 60_000);
Promise.all([
  td.storage.get("collapsed").then((ids) => Array.isArray(ids) && (collapsed = new Set(ids)), () => {}),
  td.storage.get("openFields").then((f) => Array.isArray(f) && (openFields = new Set(f)), () => {}),
  td.storage.get("mode").then((m) => m === "hours" && (mode = "hours"), () => {}),
]).finally(() => {
  if (mode === "hours") setMode("hours");
  load();
});
