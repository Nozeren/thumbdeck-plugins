// The Azure Boards view: your work items as a tree (what's under each, yours or not, and what
// they're under), the highlighted one's page beside them, laid out as Azure DevOps does, and
// the changes you make to them (state, assignee, a comment, time in a work log…); the hours you
// logged, day by day (w: a calendar); a search (F). Any other work item (one in the calendar, a
// search, Related work, a #123 link) opens its page here too, and Esc goes back. The backend asks
// Azure DevOps (backend.js); this shows what it has.
import { branchName, isMe, isTask, rows, sprintOnly, typedValue } from "./ado.js";
import { byDay, dayKey, hoursText, weeks } from "./hours.js";
import { toMarkdown } from "./markdown.js";
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
  if (pickedComment && pickedComment.id !== it.id) pickedComment = null;
  const d = details.get(it.id);
  const p = d && !d.error ? d : null;
  const then = divider.get(it.id);
  const isNew = (x) => since(x.at, then) && !isMe(x.byId, data.me);
  const changed = new Set((p?.history ?? []).filter(isNew).map((e) => e.kind)); // what changed since you looked
  const rich = []; // html for the [data-rich] slots, made safe below
  const slot = (html) => `<div data-rich="${rich.push(html) - 1}"></div>`;
  const section = (title, body, cls = "") => (body ? `<section${cls ? ` class="${cls}"` : ""}><h3>${title}</h3>${body}</section>` : "");
  const editable = (action, html, kind, title) => `<span class="editable${changed.has(kind) ? " changed" : ""}" data-edit="${action}" title="${title}">${html}</span>`;
  // Any other field: a click changes it (Space x picks one)
  const typable = (ref, html) => `<span class="editable" data-edit-field="${esc(ref)}" title="Change it">${html}</span>`;
  const value = (f) => (f.format === "link" && /^https?:\/\//i.test(f.value) ? `<a class="link" data-href="${esc(f.value)}">${esc(f.value)}</a>`
    : EDITABLE[f.ref] ? editable(EDITABLE[f.ref], esc(valueText(f.value, f.format)), EDITABLE[f.ref], "Change it")
    : f.ref ? typable(f.ref, esc(valueText(f.value, f.format)))
    : esc(valueText(f.value, f.format)));
  const fields = (list) => list.map((f) => `<dt>${esc(f.label)}</dt><dd>${value(f)}</dd>`).join("");

  // Its properties: the ones that change with a click first
  const tags = it.tags.map((t) => `<span class="td-badge">${esc(t)}</span>`).join(" ");
  const planning = (p?.planning ?? []).filter((f) => f.ref !== "Microsoft.VSTS.Common.Priority");
  const properties = `<dl class="fields props">
      <dt>State ${kbd("r")}</dt><dd>${editable("state", `<i class="dot ${stateClass(it.state)}"></i>${esc(it.state)}`, "state", "Change the state (r)")}${p?.reason ? ` <span class="td-muted">${esc(p.reason)}</span>` : ""}</dd>
      <dt>Assigned ${kbd("Space u")}</dt><dd>${editable("assign", esc(it.assignedTo || "Unassigned"), "assignee", "Assign it (Space u)")}</dd>
      <dt>Iteration ${kbd("Space m")}</dt><dd>${editable("iteration", esc(lastPart(it.iteration) || "—"), "iteration", `${esc(it.iteration)}: move it (Space m)`)}</dd>
      ${p?.area ? `<dt>Area</dt><dd${changed.has("area") ? ' class="changed"' : ""}>${typable("System.AreaPath", esc(lastPart(p.area)))}</dd>` : ""}
      <dt>Priority ${kbd("Space n")}</dt><dd>${editable("priority", esc(it.priority ?? "—"), "priority", "Change the priority (Space n)")}</dd>
      <dt>Tags ${kbd("Space g")}</dt><dd>${editable("tags", tags || `<span class="td-muted">+ add</span>`, "tags", "Edit the tags (Space g)")}</dd>
      ${fields(planning)}
      <dt></dt><dd><span class="editable td-muted" data-edit="field" title="Change another of its fields (Space x)">+ another field ${kbd("Space x")}</span></dd></dl>`;
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
    const pickedOne = theComment(it);
    const yours = (x) => (x.mine && x.id != null ? `<span class="yours"><button data-comment-edit="${x.id}" title="Change it (]t, then i)">Edit</button><button data-comment-delete="${x.id}" title="Take it back (]t, then dd)">✕</button></span>` : "");
    const entry = (x) => (x.comment
      ? `<li class="comment${isNew(x) ? " new" : ""}${pickedOne && pickedOne.id === x.id ? " picked" : ""}"><div class="by"><span class="avatar">${esc((x.by || "?")[0])}</span>${esc(x.by)} <span class="td-muted">${esc(ago(x.at))}${x.edited ? " · edited" : ""}</span>${yours(x)}</div>${slot(x.html)}</li>`
      : `<li class="event${isNew(x) ? " new" : ""}"><span class="who">${esc(x.by)}</span> ${eventText(x)} <span class="td-muted when">· ${esc(ago(x.at))}</span></li>`);
    const writeButton = (ref, first) => `<button class="write" data-edit-field="${esc(ref)}" title="Write it, as Markdown${first ? " (Space d)" : ""}">Edit${first ? ` ${kbd("Space d")}` : ""}</button>`;
    main = (p.rich.length ? p.rich.map((r, n) => section(`${esc(r.label)} ${dataIn(r.source) ? "" : writeButton(r.ref, n === 0)}`, `<div class="text" data-field="${esc(r.label)}">${slot(r.html)}</div>`)).join("")
      : section(`Description ${writeButton("System.Description", true)}`, `<p class="td-muted">No description.</p>`))
      + (p.worklog ? workLogSection(p.worklog, section) : "")
      + section(`Activity <span class="td-muted">${p.comments.length ? `${p.comments.length} comment${p.comments.length > 1 ? "s" : ""}` : ""}</span>`, `<ol class="activity">
        ${folded ? `<li class="more"><button data-unfold="${it.id}">Show ${folded} earlier</button></li>` : ""}
        ${activity.map((x, n) => (n < folded ? "" : (n === firstNew ? `<li class="divider"><span>New since you last looked</span></li>` : "") + entry(x))).join("")}
      </ol>
      <div class="composer"><textarea id="compose" rows="3" placeholder="Write a comment… (Markdown works · Ctrl+Enter: send)"></textarea>
        <div class="buttons"><span class="td-muted">${kbd("cc")} here · @ mentions someone · ${kbd("Esc")} leave</span><button id="compose-send">Comment ${kbd("Ctrl+Enter")}</button></div></div>`, "activity-section");
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
    mentioning(compose, draftMentions.get(it.id) ?? []);
    if (typing) {
      compose.focus();
      compose.setSelectionRange(...typing);
    }
  }
  box.scrollTop = top;

  if (!fresh.has(it.id) && !asking.has(it.id)) {
    asking.add(it.id);
    td.backend.call("detail", { id: it.id })
      .then((v) => (details.set(it.id, v), remember(v.people)), (e) => !p && details.set(it.id, { error: e.message }))
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
    const mentions = (draftMentions.get(it.id) ?? []).filter((m) => typed.includes(`@${m.name}`));
    const { error } = await td.backend.call("comment", { id: it.id, text: typed, mentions });
    if (error) throw new Error(error);
    drafts.delete(it.id);
    draftMentions.delete(it.id);
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
const draftMentions = new Map(); // id -> the people @mentioned in it ([{ name, id }])

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
function ask({ label, value = "", choices = null, free = !choices, hint = "", search = null }) {
  const box = $("ask");
  const field = $("ask-input");
  $("ask-label").textContent = label;
  $("ask-ok").hidden = !!choices && !free; // picking a choice is the saving
  $("ask-hint").textContent = hint || (choices ? `↑↓ pick · Enter${free ? " (or what you typed)" : ""} · Esc: cancel` : "Enter: save · Esc: cancel");
  box.hidden = false;
  field.value = value;
  let at = 0;
  let found = []; // search(typed)'s, for what's typed now
  let waiting = null;
  const matching = () => {
    const w = field.value.trim().toLowerCase();
    const mine = (choices ?? []).filter((c) => !w || field.value === value || `${c.label} ${c.note ?? ""}`.toLowerCase().includes(w));
    const have = new Set(mine.map((c) => String(c.value).toLowerCase()));
    return [...mine, ...found.filter((c) => !have.has(String(c.value).toLowerCase()))];
  };
  const hintText = $("ask-hint").textContent;
  // Searching as you type (people in the organization): a moment after the last key
  const lookFor = () => {
    clearTimeout(waiting);
    const q = field.value.trim();
    if (!search || q.length < 2 || field.value === value) return (found = []), draw();
    waiting = setTimeout(async () => {
      $("ask-hint").textContent = `Searching for “${q}”…`;
      const got = await search(q).catch((e) => ({ choices: [], error: e.message }));
      if (box.hidden || field.value.trim() !== q) return;
      found = got.choices ?? [];
      $("ask-hint").textContent = got.error ? `Couldn't search: ${got.error}` : hintText;
      draw();
    }, 250);
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
      clearTimeout(waiting);
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
    const typed = () => ((at = 0), draw(), lookFor());
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
    remember(choices);
    const to = await ask({ label: `Assign ${it.type} ${it.id} (now ${it.assignedTo || "nobody"}) to…`, choices, free: true, search: findPeople,
      hint: "Type a name or an email: anyone in your organization · ↑↓ pick · Enter · Esc: cancel" });
    if (to !== null) await change(it, { assignee: to }, to ? `assigned to ${people.get(to.toLowerCase())?.label ?? to}` : "unassigned");
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

// People: the ones known (yours, the list's, a page's, found by a search), by email, with their
// ids (an @mention needs one); anyone else in the organization through the people search
const people = new Map();
/** Keeps what's known of people ({ value: email, label, note, id }) */
function remember(list) {
  for (const p of list ?? []) {
    if (!p?.value) continue;
    const was = people.get(p.value.toLowerCase());
    people.set(p.value.toLowerCase(), { ...was, ...p, label: p.label === "Me" && was?.label ? was.label : p.label, id: p.id || was?.id || "" });
  }
}
/** The people search (backend.js people), as the ask box takes it */
async function findPeople(q) {
  const { people: found, error } = await td.backend.call("people", { text: q });
  remember(found);
  return { choices: found, error };
}
/** The people to @mention on a work item: its page's, then the list's, then the rest known */
function mentionable(it) {
  const out = new Map();
  const add = (p) => p?.id && p.value && !out.has(p.value.toLowerCase()) && out.set(p.value.toLowerCase(), people.get(p.value.toLowerCase()) ?? p);
  for (const p of details.get(it?.id)?.people ?? []) add(p);
  for (const i of data.items) add({ value: i.assignee, label: i.assignedTo, note: i.assignee, id: i.assigneeId });
  for (const p of people.values()) add(p);
  return [...out.values()].filter((p) => !isMe(p.value, data.me));
}

// @mentions while writing (a comment, a description): @ and a few letters offer people; the one
// picked becomes @Their Name, which Azure DevOps turns into a mention (and tells them)
const picked = new WeakMap(); // textarea -> Map(name -> id)
let suggest = null; // { area, start, list, at, q }
let suggestWait = null;

/** The @… being typed before the cursor: { start, q } or null */
function atMention(area) {
  const before = area.value.slice(0, area.selectionStart);
  const m = /(^|[\s(])@([^\s@]{0,30}(?: [^\s@]{0,30})?)$/.exec(before);
  if (!m) return null;
  const q = m[2];
  const names = [...(picked.get(area)?.keys() ?? [])];
  if (names.some((n) => q.startsWith(`${n} `) || q === `${n} `)) return null; // already one
  return { start: before.length - q.length - 1, q };
}

/** Where the cursor is in a textarea, on the screen: { x, y, h (a line's height) } (a hidden
 *  copy of it, laid out the same, up to the cursor) */
function caretAt(area) {
  const s = getComputedStyle(area);
  const copy = document.createElement("div");
  for (const k of ["boxSizing", "width", "borderTopWidth", "borderRightWidth", "borderBottomWidth", "borderLeftWidth", "paddingTop", "paddingRight",
    "paddingBottom", "paddingLeft", "fontStyle", "fontVariant", "fontWeight", "fontSize", "lineHeight", "fontFamily", "letterSpacing", "wordSpacing", "tabSize", "textIndent"]) copy.style[k] = s[k];
  Object.assign(copy.style, { position: "absolute", visibility: "hidden", whiteSpace: "pre-wrap", overflowWrap: "break-word", top: "0", left: "-9999px", height: "auto" });
  copy.textContent = area.value.slice(0, area.selectionStart);
  const mark = document.createElement("span");
  mark.textContent = "\u200b";
  copy.append(mark);
  document.body.append(copy);
  const r = area.getBoundingClientRect();
  const at = { x: r.left + mark.offsetLeft - area.scrollLeft, y: r.top + mark.offsetTop - area.scrollTop, h: parseFloat(s.lineHeight) || parseFloat(s.fontSize) * 1.4 || 18 };
  copy.remove();
  return at;
}

function drawSuggest() {
  const el = $("mention");
  if (!suggest || !suggest.list.length) return void (el.hidden = true);
  // Under the @… being typed (over it, near the bottom of the window)
  const c = caretAt(suggest.area);
  const width = 340;
  el.style.width = `${width}px`;
  el.style.left = `${Math.max(8, Math.min(c.x - 12, window.innerWidth - width - 8))}px`;
  const below = window.innerHeight - (c.y + c.h) > 200;
  el.style.top = below ? `${c.y + c.h + 2}px` : "";
  el.style.bottom = below ? "" : `${window.innerHeight - c.y + 2}px`;
  el.innerHTML = suggest.list.map((p, n) => `<li class="${n === suggest.at ? "cursor" : ""}" data-mention="${n}"><span class="avatar">${esc((p.label || "?")[0])}</span>${esc(p.label)} <span class="td-muted">${esc(p.note ?? p.value)}</span></li>`).join("")
    + `<li class="td-muted hint">↑↓ · Enter or Tab: mention · Esc</li>`;
  el.hidden = false;
}

function closeSuggest() {
  suggest = null;
  clearTimeout(suggestWait);
  $("mention").hidden = true;
}

/** Offers people for the @… being typed (the ones known at once, the organization's a moment later) */
function offer(area) {
  const m = atMention(area);
  if (!m) return closeSuggest();
  const it = showingItem();
  const q = m.q.toLowerCase();
  const local = mentionable(it).filter((p) => !q || `${p.label} ${p.value}`.toLowerCase().includes(q)).slice(0, 8);
  suggest = { area, start: m.start, list: local, at: 0, q: m.q };
  drawSuggest();
  clearTimeout(suggestWait);
  if (m.q.length < 2) return;
  suggestWait = setTimeout(async () => {
    const { choices } = await findPeople(m.q).catch(() => ({ choices: [] }));
    if (!suggest || suggest.area !== area || suggest.q !== m.q) return;
    const have = new Set(suggest.list.map((p) => p.value.toLowerCase()));
    suggest.list = [...suggest.list, ...choices.filter((p) => p.id && !have.has(p.value.toLowerCase()) && !isMe(p.value, data.me))].slice(0, 10);
    drawSuggest();
  }, 250);
}

/** The highlighted person, mentioned where the @… is */
function pickMention(n = suggest?.at) {
  const p = suggest?.list[n];
  if (!p) return closeSuggest();
  const { area, start } = suggest;
  const name = p.label.replace(/^Me$/, p.value);
  const end = area.selectionStart;
  area.value = `${area.value.slice(0, start)}@${name} ${area.value.slice(end)}`;
  const at = start + name.length + 2;
  area.setSelectionRange(at, at);
  if (!picked.has(area)) picked.set(area, new Map());
  picked.get(area).set(name, p.id);
  closeSuggest();
  area.dispatchEvent(new Event("input", { bubbles: true }));
  area.focus();
}

/** The people mentioned in a text: the ones picked whose @Name is still in it */
const mentionsIn = (area, text) => [...(picked.get(area) ?? new Map())].filter(([name]) => text.includes(`@${name}`)).map(([name, id]) => ({ name, id }));

/** Lets a textarea mention people (mentions: the ones already in its text) */
function mentioning(area, mentions = []) {
  picked.set(area, new Map(mentions.map((m) => [m.name, m.id])));
  if (area.dataset.mentioning) return;
  area.dataset.mentioning = "1";
  area.addEventListener("input", () => offer(area));
  area.addEventListener("click", () => offer(area));
  area.addEventListener("blur", () => setTimeout(() => suggest?.area === area && document.activeElement !== area && closeSuggest(), 150));
  area.addEventListener("keydown", (e) => {
    if (!suggest || suggest.area !== area || !suggest.list.length) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      suggest.at = (suggest.at + (e.key === "ArrowDown" ? 1 : -1) + suggest.list.length) % suggest.list.length;
      drawSuggest();
    } else if ((e.key === "Enter" && !e.ctrlKey && !e.metaKey) || e.key === "Tab") pickMention();
    else if (e.key === "Escape") closeSuggest();
    else return;
    e.preventDefault();
    e.stopPropagation(); // not the comment box's own (Esc: leave it)
  });
}
$("mention").addEventListener("mousedown", (e) => {
  const li = e.target.closest("[data-mention]");
  e.preventDefault();
  if (li) pickMention(Number(li.dataset.mention));
});

/** Asks for a long text in the view's editor (Markdown, @mentions): { text, mentions }, or null
 *  (Esc / Cancel; asked first if it was changed) */
function write({ label, value = "", note = "", lost = [], mentions = [], hint = "" }) {
  const box = $("editor");
  const area = $("editor-text");
  $("editor-label").textContent = label;
  $("editor-note").textContent = note;
  $("editor-lost").hidden = !lost.length;
  $("editor-lost").textContent = lost.length ? `Markdown can't keep its ${lost.join(", ")}: saving it from here loses them (Azure DevOps' editor keeps them).` : "";
  $("editor-hint").textContent = hint || "Markdown · @ mentions someone · #123 links a work item · Ctrl+Enter: save · Esc: cancel";
  box.hidden = false;
  area.value = value;
  mentioning(area, mentions);
  area.focus();
  area.setSelectionRange(area.value.length, area.value.length);
  area.scrollTop = area.scrollHeight;
  return new Promise((resolve) => {
    const done = (answer) => {
      box.hidden = true;
      closeSuggest();
      area.removeEventListener("keydown", key);
      $("editor-ok").onclick = $("editor-cancel").onclick = null;
      area.blur();
      td.keys.take();
      resolve(answer);
    };
    const save = () => done({ text: area.value, mentions: mentionsIn(area, area.value) });
    const cancel = async () => {
      if (area.value !== value && !(await td.ui.confirm("Leave without saving what you changed?", { yes: "Leave it", no: "Keep writing" }))) return area.focus();
      done(null);
    };
    const key = (e) => {
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) return e.preventDefault(), save();
      if (e.key === "Escape") return e.preventDefault(), cancel();
    };
    area.addEventListener("keydown", key);
    $("editor-ok").onclick = save;
    $("editor-cancel").onclick = cancel;
  });
}

// Making work items: o, a task under the highlighted story or bug (beside it, for a task);
// Space a, any type, under it or on its own. Yours, in the current sprint.
/** Where a new task goes for the highlighted work item: { parent (a work item, or null), project } */
function taskPlace(it) {
  if (!isTask(it.type)) return { parent: it, project: it.project };
  const parent = data.items.find((i) => i.id === it.parent) ?? (it.parent ? { id: it.parent, type: "", title: `#${it.parent}`, project: it.project } : null);
  return { parent, project: it.project };
}
const named = (i) => `${i.type ? `${i.type} ` : ""}${i.id}${i.title ? ` “${i.title}”` : ""}`;

/** Makes a work item (title: asked if none) and shows it */
async function create({ type = "", parent = null, project, title = "" }) {
  const what = type || "task";
  const t = (title || (await ask({ label: `New ${what.toLowerCase()} ${parent ? `under ${named(parent)}` : `in ${project}`}: its title`, hint: "Yours, in the current sprint · Enter: make it · Esc: cancel" })) || "").trim();
  if (!t) return;
  td.ui.say(`making the ${what.toLowerCase()}…`);
  try {
    const made = await td.backend.call("create", { parent: parent?.id ?? null, type, title: t, project });
    await load();
    td.ui.say(`made ${made.type} ${made.id}${made.iteration ? ` in ${lastPart(made.iteration)}` : ""}${made.error ? ` (${made.error})` : ""}`);
    if (mode === "list" && select(made.id)) return;
    openItem(made.id);
  } catch (e) {
    td.ui.say(e.message, { error: true });
  }
}

async function newTask(it, title = "") {
  if (!it) return td.ui.say("highlight the story or bug to put the task under", { error: true });
  const { parent, project } = taskPlace(it);
  await create({ parent, project, title });
}

async function addItem(it) {
  if (!it) return td.ui.say("highlight a work item of the project first", { error: true });
  const types = await options(it, "type");
  const type = types && (await ask({ label: `Add a work item in ${it.project}: its type`, choices: types }));
  if (!type) return;
  const where = await ask({ label: `The new ${type.toLowerCase()}: where?`, choices: [
    { value: "under", label: `Under ${named(it)}` },
    ...(it.parent ? [{ value: "beside", label: `Beside it, under #${it.parent}` }] : []),
    { value: "alone", label: `On its own, in ${it.project}` },
  ] });
  if (!where) return;
  const parent = where === "under" ? it : where === "beside" ? taskPlace({ ...it, type: "Task" }).parent : null;
  await create({ type, parent, project: it.project });
}

// Changing any field: its description (Space d, as Markdown), or any other (Space x, or a click
// on it in the properties)
async function typedFieldsOf(it) {
  try {
    return await td.backend.call("fields", { id: it.id });
  } catch (e) {
    td.ui.say(e.message, { error: true });
    return null;
  }
}
const shortValue = (f) => {
  const v = typedValue(f.kind, f.value);
  return f.kind === "html" ? (v ? "rich text" : "empty") : v.length > 40 ? `${v.slice(0, 40)}…` : v || "empty";
};

/** Edits its main text (Description, or Repro steps…: picked when its type has several) */
async function editText(it) {
  const got = await typedFieldsOf(it);
  if (!got) return;
  const texts = got.fields.filter((f) => (f.kind === "html" || f.kind === "long") && !dataIn(f.value));
  if (!texts.length) return td.ui.say(`${it.type} ${it.id} has no text to write`, { error: true });
  const order = (f) => (f.ref === "System.Description" ? 0 : f.value ? 1 : 2);
  texts.sort((a, b) => order(a) - order(b));
  // Straight to it when there's no other text written (a bug's repro steps: asked which)
  const ref = !texts.slice(1).some((f) => f.value)
    ? texts[0].ref
    : await ask({ label: `Which text of ${it.type} ${it.id}?`, choices: texts.map((f) => ({ value: f.ref, label: f.name, note: shortValue(f) })) });
  const f = ref && texts.find((x) => x.ref === ref);
  if (f) await editField(it, f, got.rev);
}

/** Picks one of its fields to change */
async function pickField(it) {
  const got = await typedFieldsOf(it);
  if (!got) return;
  const ref = await ask({ label: `Change a field of ${it.type} ${it.id}`, choices: got.fields.map((f) => ({ value: f.ref, label: f.name, note: shortValue(f) })),
    hint: "Type to narrow · ↑↓ pick · Enter · Esc (state r, assignee Space u, title i, tags Space g, priority Space n, iteration Space m)" });
  const f = ref && got.fields.find((x) => x.ref === ref);
  if (f) await editField(it, f, got.rev);
}

/** Changes the field with this reference name (clicked in its properties) */
async function editRef(it, ref) {
  const got = await typedFieldsOf(it);
  const f = got?.fields.find((x) => x.ref.toLowerCase() === String(ref).toLowerCase());
  if (got && !f) return td.ui.say(`${ref} can't be changed from here`, { error: true });
  if (f) await editField(it, f, got.rev);
}

/** A text field that holds data (a JSON list or object: a work log…), not words */
const dataIn = (v) => /^\s*[[{]/.test(String(v ?? "").replace(/&quot;/g, '"')) && /^\s*[[{][\s\S]*[\]}]\s*$/.test(String(v ?? "").replace(/<[^>]+>/g, ""));

/** Asks a field's new value, as its kind is typed, and writes it */
async function editField(it, f, rev) {
  const label = `${f.name} of ${it.type} ${it.id}`;
  const now = typedValue(f.kind, f.value);
  let typed;
  let mentions = [];
  if ((f.kind === "html" || f.kind === "long") && dataIn(now)) return td.ui.say(`${f.name} holds data (JSON), not text: change it in Azure DevOps${/worklog/i.test(f.ref) ? " (or Space l, with the Hours field setting)" : ""}`, { error: true });
  if (f.kind === "html" || f.kind === "long") {
    const md = f.kind === "long" || f.markdown ? { text: now, mentions: [], lost: [] } : toMarkdown(now);
    const got = await write({ label, value: md.text, mentions: md.mentions, lost: md.lost,
      note: f.markdown ? "Kept as Markdown" : f.kind === "html" ? "Written as Markdown, kept as Azure DevOps' rich text" : "" });
    if (!got) return;
    if (got.text.trim() === md.text.trim()) return td.ui.say("nothing changed");
    typed = got.text;
    mentions = got.mentions;
  } else {
    const empty = f.required ? [] : [{ value: "\u0000", label: "(empty)", note: "nothing in it" }];
    let choices = null;
    let search = null;
    if (f.allowed.length) choices = [...f.allowed.map((v) => ({ value: v, label: v })), ...empty];
    else if (f.kind === "yes-no") choices = [{ value: "yes", label: "Yes" }, { value: "no", label: "No" }, ...empty];
    else if (f.kind === "path" && f.ref === "System.AreaPath") choices = await options(it, "area");
    else if (f.kind === "person") {
      choices = [...(data.me ? [{ value: data.me, label: "Me", note: data.me }] : []), ...mentionable(it), ...empty];
      search = findPeople;
    }
    const hint = { date: "A day, YYYY-MM-DD · empty: none · Enter · Esc", number: "A number · empty: none · Enter · Esc", integer: "A whole number · empty: none · Enter · Esc" }[f.kind];
    typed = await ask({ label: `${label}${now ? ` (now ${now})` : ""}`, value: choices ? "" : now, choices, free: !choices || f.kind === "person" || f.kind === "path", search, hint });
    if (typed === null) return;
    if (typed === "\u0000") typed = "";
    if (typed.trim() === now) return td.ui.say("nothing changed");
  }
  try {
    const { error } = await td.backend.call("setField", { id: it.id, ref: f.ref, kind: f.kind, value: typed, had: f.value != null && f.value !== "", rev, markdown: f.markdown, mentions });
    if (error) throw new Error(error);
    fresh.delete(it.id);
    td.ui.say(`${it.type} ${it.id}: ${f.name} ${typed.trim() ? "changed" : "emptied"}`);
  } catch (e) {
    td.ui.say(e.message, { error: true });
  }
  await load();
}

// Your comments: ]t / [t highlight one, i (or Edit) changes it, dd (or ✕) takes it back
let pickedComment = null; // { id: the work item's, comment: its id }

/** The comments on the shown page, in the order they show */
const shownComments = (it) => [...(details.get(it?.id)?.comments ?? [])].filter((c) => c.at).sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
const theComment = (it) => (pickedComment && it && pickedComment.id === it.id ? shownComments(it).find((c) => c.id === pickedComment.comment) : null);

/** Highlights the next (by 1) or previous (-1) comment */
function nextComment(it, by) {
  const list = shownComments(it);
  if (!it || !list.length) return td.ui.say("no comments on it");
  const at = list.findIndex((c) => c.id === theComment(it)?.id);
  const to = at < 0 ? (by > 0 ? 0 : list.length - 1) : at + by;
  if (to < 0 || to >= list.length) {
    pickedComment = null;
    detail();
    return td.ui.say(by > 0 ? "that was the last comment" : "that was the first comment");
  }
  pickedComment = { id: it.id, comment: list[to].id };
  if (list[to].by) td.ui.say(list[to].mine ? "your comment: i edits it, dd takes it back" : `${list[to].by}'s comment`);
  detail();
  document.querySelector("#detail .comment.picked")?.scrollIntoView({ block: "center" });
}

async function editComment(it, c) {
  if (!c?.mine) return td.ui.say("only your own comments can be changed", { error: true });
  const md = c.markdown ? { text: c.source, mentions: [], lost: [] } : toMarkdown(c.source);
  const got = await write({ label: `Your comment on ${it.type} ${it.id}`, value: md.text, mentions: md.mentions, lost: md.lost });
  if (!got || got.text.trim() === md.text.trim()) return;
  try {
    await td.backend.call("editComment", { id: it.id, comment: c.id, text: got.text, mentions: got.mentions, markdown: c.markdown });
    fresh.delete(it.id);
    td.ui.say("comment changed");
  } catch (e) {
    td.ui.say(e.message, { error: true });
  }
  detail();
}

async function deleteComment(it, c) {
  if (!c) return td.ui.say("highlight your comment first (]t)", { error: true });
  if (!c.mine) return td.ui.say("only your own comments can be taken back", { error: true });
  const preview = (c.source ? toMarkdown(c.source).text : "").replace(/\s+/g, " ").slice(0, 80);
  if (!(await td.ui.confirm(`Take back your comment on ${it.type} ${it.id}?${preview ? `\n\n“${preview}”` : ""}`, { yes: "Take it back", no: "Keep it" }))) return;
  try {
    const { error } = await td.backend.call("deleteComment", { id: it.id, comment: c.id });
    if (error) throw new Error(error);
    pickedComment = null;
    fresh.delete(it.id);
    td.ui.say("comment taken back");
  } catch (e) {
    td.ui.say(e.message, { error: true });
  }
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
    case "new": return $("ask").hidden && newTask(details.get(it?.id)?.item ?? it);
    case "add": return $("ask").hidden && addItem(details.get(it?.id)?.item ?? it);
    case "description": return it && $("ask").hidden && editText(it);
    case "field": return it && $("ask").hidden && pickField(it);
    case "next-thread": return nextComment(it, 1);
    case "previous-thread": return nextComment(it, -1);
    case "delete": return it && deleteComment(it, theComment(it));
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
td.on("key", ({ action }) => {
  // A comment highlighted (]t): i changes it, Esc lets it go
  const it = showingItem();
  const c = theComment(it);
  if (c && action === "edit") return $("ask").hidden && editComment(it, c);
  if (c && action === "leave") return (pickedComment = null), detail();
  act(ALIAS[action] ?? action);
});
// :task Its title — a task under the highlighted work item, with that title
td.on("command", ({ name, arg }) => {
  if (/^(task|new-task)$/i.test(name)) return $("ask").hidden && newTask(showingItem(), String(arg ?? "").trim());
});

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
    case "new": return $("ask").hidden && newTask(it);
    case "add": return $("ask").hidden && addItem(it);
    case "description": return it && $("ask").hidden && editText(it);
    case "field": return it && $("ask").hidden && pickField(it);
    case "next-thread": return nextComment(it, 1);
    case "previous-thread": return nextComment(it, -1);
    case "delete": return it && deleteComment(it, theComment(it));
    case "refresh":
      fresh.clear();
      td.ui.say("looking again…");
      return td.backend.call("refresh").then(load);
  }
}
// The comment box: kept while you write (a look again redraws the page), Ctrl+Enter sends
document.addEventListener("input", (e) => {
  if (e.target.id !== "compose" || !showing) return;
  drafts.set(showing, e.target.value);
  draftMentions.set(showing, mentionsIn(e.target, e.target.value));
});
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
  const fieldClick = e.target.closest("[data-edit-field]");
  if (fieldClick) return showingItem() && $("ask").hidden && editRef(showingItem(), fieldClick.dataset.editField);
  const commentClick = e.target.closest("[data-comment-edit], [data-comment-delete]");
  if (commentClick) {
    const it = showingItem();
    const id = Number(commentClick.dataset.commentEdit ?? commentClick.dataset.commentDelete);
    const c = shownComments(it).find((x) => x.id === id);
    pickedComment = c ? { id: it.id, comment: c.id } : null;
    return commentClick.dataset.commentEdit != null ? editComment(it, c) : deleteComment(it, c);
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
