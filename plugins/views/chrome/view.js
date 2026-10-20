// The Chrome view: the browser's profiles grouped by tenant beside the highlighted one's details,
// and the link rules (Tab). The backend reads and changes everything (backend.js).
import { COLORS, ago, initials, matches } from "./chrome.js";

const td = window.thumbdeck;
const esc = td.escape;
const $ = (id) => document.getElementById(id);

let data = { browser: "Chrome", found: true, problem: "", running: false, tenants: [], profiles: [], rules: [] };
let page = "list"; // or "rules"
let cursor = null; // the highlighted profile's folder
let ruleCursor = 0;
let words = "";
let only = null; // a tenant's id
let showHidden = false;
const folded = new Set();
let layer = null; // { kind: "profile" | "tenant" | "rule" | "move" | "ask", … }

const ROLE_COLOR = { admin: "red", dev: "blue", test: "yellow", ops: "aqua", guest: "purple", me: "green", personal: "green" };
const roleColor = (r) => `var(--${ROLE_COLOR[r?.toLowerCase()] ?? "grey"})`;
const colorOf = (p) => (p.color ? `var(--${p.color})` : p.chromeColor ?? `var(--${COLORS[p.i % COLORS.length]})`);
const tenant = (id) => data.tenants.find((t) => t.id === id) ?? { id, name: id, domains: [] };
const profile = (dir) => data.profiles.find((p) => p.dir === dir);
const older = (a, b) => { const x = a.split(".").map(Number), y = b.split(".").map(Number); for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) < (y[i] || 0); return false; };
const routes = !older(td.context.thumbdeck, "0.9.0");

function mark(text) {
  const t = esc(text);
  if (!words) return t;
  const re = new RegExp(words.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
  return t.replace(re, (m) => `<mark>${m}</mark>`);
}

/** The profiles shown, in tenants' order */
function shown() {
  const w = words.toLowerCase();
  const list = data.profiles.filter((p) => (showHidden || !p.hidden) && (!only || p.tenant === only)
    && (!w || `${p.name} ${p.email} ${p.role} ${tenant(p.tenant).name}`.toLowerCase().includes(w)));
  return data.tenants.map((t) => ({ t, items: list.filter((p) => p.tenant === t.id) })).filter((g) => g.items.length);
}
const rows = () => shown().flatMap((g) => (folded.has(g.t.id) && !words ? [] : g.items));
const current = () => profile(cursor);

async function load() {
  try {
    data = await td.backend.call("list");
  } catch (e) {
    data.problem = e.message;
  }
  const r = rows();
  if (!r.some((p) => p.dir === cursor)) cursor = r[0]?.dir ?? null;
  ruleCursor = Math.min(ruleCursor, Math.max(0, data.rules.length - 1));
  render();
}

function avatar(p, cls = "") {
  return `<span class="av ${cls}" style="background:${colorOf(p)}">${esc(initials(p.name))}${p.open ? '<span class="live" title="a window is open"></span>' : ""}</span>`;
}

function render() {
  const visible = data.profiles.filter((p) => showHidden || !p.hidden);
  const counts = (id) => visible.filter((p) => p.tenant === id).length;
  $("bar").innerHTML = `
    <button class="seg" aria-pressed="${page === "list"}" data-page="list">Profiles <b>${visible.length}</b></button>
    <button class="seg" aria-pressed="${page === "rules"}" data-page="rules">Link rules <b>${data.rules.length}</b></button><kbd>Tab</kbd>
    ${page === "list" && data.tenants.length > 1 ? `<span class="td-chips">${data.tenants.map((t) => `<button class="td-chip" aria-pressed="${only === t.id}" data-only="${esc(t.id)}">${esc(t.name)} <b>${counts(t.id)}</b></button>`).join("")}<kbd>Space f</kbd></span>` : ""}
    <span class="spacer"></span>
    ${data.profiles.some((p) => p.hidden) && page === "list" ? `<button class="tool" data-act="hidden">${showHidden ? "Leave out" : "Show"} hidden <kbd>Space h</kbd></button>` : ""}
    <button data-act="new">+ New <kbd>o</kbd></button>`;
  $("error").hidden = !data.problem;
  $("error").textContent = data.problem;
  $("profiles").hidden = page !== "list";
  $("rules").hidden = page !== "rules";
  if (page === "list") renderProfiles();
  else renderRules();
}

function renderProfiles() {
  let html = "";
  for (const { t, items } of shown()) {
    const fold = folded.has(t.id) && !words;
    html += `<li class="td-group" data-fold="${esc(t.id)}"><span class="caret">${fold ? "▸" : "▾"}</span>${esc(t.name)}${t.domains[0] ? `<span class="dom">@${esc(t.domains.join(", @"))}</span>` : ""}<span class="n">${items.length}</span></li>`;
    if (fold) continue;
    for (const p of items) {
      html += `<li class="td-row${p.hidden ? " hidden" : ""}" aria-selected="${p.dir === cursor}" data-dir="${esc(p.dir)}">${avatar(p)}
        <span class="td-l1"><span class="td-title">${mark(p.name)}</span>${p.role ? `<span class="role" style="color:${roleColor(p.role)}">${esc(p.role)}</span>` : ""}${p.pending ? '<span class="td-tag">new</span>' : ""}${p.hidden ? '<span class="td-tag">hidden</span>' : ""}</span>
        <span class="td-side">${esc(ago(p.used))}</span>
        <span class="td-l2">${p.email ? mark(p.email) : '<span class="td-muted">not signed in</span>'}</span></li>`;
    }
  }
  $("rows").innerHTML = html || `<li class="td-empty">${data.found ? (words || only ? "No profile matches." : "No profiles.") : `${esc(data.browser)} isn't set up here.`} o makes one.</li>`;
  $("rows").querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });

  const p = current();
  if (!p) return ($("details").innerHTML = "");
  const t = tenant(p.tenant);
  const rules = data.rules.filter((r) => r.dir === p.dir);
  $("details").innerHTML = `
    <div class="who">${avatar(p, "big")}<div><h3>${esc(p.name)}</h3><div class="td-sub">${esc(p.email || "not signed in")}</div></div></div>
    <dl class="facts">
      <dt>Tenant</dt><dd>${esc(t.name)}${t.domains[0] ? ` <span class="td-muted">@${esc(t.domains.join(", @"))}</span>` : ""}</dd>
      ${p.role ? `<dt>Role</dt><dd><span class="role" style="color:${roleColor(p.role)}">${esc(p.role)}</span></dd>` : ""}
      <dt>${esc(data.browser)}</dt><dd>${esc(p.dir)}${p.name !== p.chromeName && !p.pending ? ` <span class="td-muted">“${esc(p.chromeName)}”</span>` : ""}${p.open ? ' <span class="td-green">· window open</span>' : ""}${p.pending ? ' <span class="td-muted">· shows its account once you sign in</span>' : ""}</dd>
      ${p.used ? `<dt>Last used</dt><dd>${esc(ago(p.used))}</dd>` : ""}
    </dl>
    <div class="td-sect"><h5>Shortcuts <span class="r">i to change</span></h5>
      ${p.shortcuts.length ? p.shortcuts.map(([name, url], k) => `<div class="td-item short" data-short="${k}">${k < 26 ? `<kbd style="margin:0">'${"abcdefghijklmnopqrstuvwxyz"[k]}</kbd>` : '<span style="width:17px"></span>'}${esc(name)}<span class="u">${esc(url.replace(/^https?:\/\//, ""))}</span></div>`).join("") : '<div class="td-muted">None yet: the pages you open in this profile, one key each.</div>'}</div>
    <div class="td-sect"><h5>Links that open here <span class="r">Tab: all rules</span></h5>
      ${rules.length ? rules.map((r) => `<div class="td-item pat">${esc(r.pattern)}</div>`).join("") : '<div class="td-muted">None.</div>'}</div>
    <div class="td-actions">
      <button class="primary" data-act="open">Open the window <kbd>Enter</kbd></button>
      <button data-act="edit">Edit <kbd>i</kbd></button><button data-act="move">Move <kbd>Space m</kbd></button>
      <button class="danger" data-act="delete">${p.hidden ? "Unhide" : "Delete"} <kbd>dd</kbd></button>
    </div>`;
}

function renderRules() {
  const list = data.rules.map((r, k) => {
    const p = profile(r.dir);
    return `<div class="rule" aria-selected="${k === ruleCursor}" data-rule="${k}"><span class="pat">${esc(r.pattern)}</span><span class="td-muted">→</span>
      <span class="to">${p ? `${avatar(p, "small")}${esc(p.name)}` : `<span class="td-red">${esc(r.dir)} is gone</span>`}</span><span class="td-muted">${p ? esc(tenant(p.tenant).name) : ""}</span></div>`;
  }).join("");
  $("rules").innerHTML = `
    <div class="try">Try a link <kbd>Space l</kbd><input id="try" placeholder="https://dev.azure.com/contoso/…" value="${esc(tryUrl)}"><span id="tried"></span></div>
    ${list || '<p class="td-empty">No rules yet. o adds one: links like <code>dev.azure.com/contoso/*</code> open in the profile you pick.</p>'}
    <p class="td-muted">The first rule that matches wins (Alt+j / Alt+k move a rule); links no rule matches open in your default browser.
    ${routes ? "thumbdeck's links (Pull requests, Azure Boards, Calendar, the review page) open through these." : "This thumbdeck is older than 0.9: its links open in the default browser; update it to have them follow these rules."}</p>
    <div class="td-actions"><button data-act="new">New rule <kbd>o</kbd></button>${data.rules.length ? '<button data-act="open">Edit <kbd>Enter</kbd></button><button class="danger" data-act="delete">Delete <kbd>dd</kbd></button>' : ""}</div>`;
  $("rules").querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
  tried();
}

let tryUrl = "";
function tried() {
  const el = $("tried");
  if (!el) return;
  if (!tryUrl) return (el.textContent = "");
  const url = /^[a-z]+:\/\//i.test(tryUrl) ? tryUrl : `https://${tryUrl}`;
  const i = data.rules.findIndex((r) => matches(r.pattern, url));
  const p = i >= 0 && profile(data.rules[i].dir);
  el.innerHTML = p ? `→ ${avatar(p, "small")} ${esc(p.name)} <span class="td-muted">(rule ${i + 1})</span>` : "→ the default browser";
  el.style.display = "flex";
  el.style.gap = "6px";
  el.style.alignItems = "center";
}

// ------------------------------------------------------------ dialogs

const opt = (value, cur, label) => `<option value="${esc(value)}"${value === cur ? " selected" : ""}>${esc(label)}</option>`;
const tenantOptions = (cur, auto) =>
  (auto ? opt("auto", cur, "from the account's domain") : "") +
  data.tenants.filter((t) => t.id !== "none").map((t) => opt(t.id, cur, t.name + (t.domains[0] ? `  @${t.domains[0]}` : ""))).join("") +
  opt("none", cur, "Ungrouped") + opt("new", "", "+ a new tenant…");
const swatches = (cur) => `<span class="sw"><button type="button" class="none" data-color="" aria-pressed="${!cur}" title="the browser's own"></button>${COLORS.map((c) => `<button type="button" data-color="${c}" aria-pressed="${cur === c}" style="background:var(--${c})"></button>`).join("")}</span>`;
const foot = (del, isNew) => `<div class="foot">${del ? `<button class="danger" data-f="delete">${del}</button>` : ""}<span class="spacer"></span><button data-f="cancel">Cancel <kbd>Esc</kbd></button><button class="primary" data-f="save">${isNew ? "Create" : "Save"} <kbd>Ctrl+Enter</kbd></button></div>`;
const newTenantFields = `<label class="newt" hidden>New tenant <input name="tname" placeholder="Contoso"></label><label class="newt" hidden>Its domains <input name="tdomains" placeholder="contoso.com, contoso.onmicrosoft.com"></label>`;

function layerHtml() {
  const l = layer;
  if (l.kind === "profile") {
    const p = l.isNew ? { name: "", email: "", tenant: "auto", role: "", color: null, shortcuts: [] } : profile(l.dir);
    const explicit = !l.isNew;
    return `<div class="dialog"><h4>${l.isNew ? `A new ${esc(data.browser)} profile` : `Edit ${esc(p.name)}`}</h4>
      <label>Name <input name="label" value="${esc(l.isNew ? "" : p.name)}" placeholder="Contoso dev"></label>
      <label>Account <input name="account" value="${esc(p.email)}" placeholder="you@contoso.com"></label>
      <div class="hint">${l.isNew ? `Optional: ${esc(data.browser)} opens on a new profile; sign in there.` : "The browser's, when it's signed in; set it for an account the browser doesn't know (Microsoft 365)."}</div>
      <label>Tenant <select name="tenant">${tenantOptions(explicit ? p.tenant : "auto", true)}</select></label>
      ${newTenantFields}
      <label>Role <input name="role" value="${esc(p.role)}" list="roles" placeholder="dev, admin, test…"><datalist id="roles">${Object.keys(ROLE_COLOR).map((r) => `<option value="${r}">`).join("")}</datalist></label>
      <label>Colour ${swatches(p.color)}</label>
      <label>Shortcuts <textarea name="shortcuts" placeholder="Azure portal | portal.azure.com">${esc(p.shortcuts.map(([n, u]) => `${n} | ${u}`).join("\n"))}</textarea></label>
      <div class="hint">One per line: name | address. 'a, 'b, 'c… open them in that order.</div>
      ${foot(l.isNew ? "" : "Delete…", l.isNew)}</div>`;
  }
  if (l.kind === "move") {
    const p = current();
    return `<div class="dialog"><h4>Move ${esc(p.name)} to</h4><label>Tenant <select name="tenant">${tenantOptions(p.tenant, true)}</select></label>${newTenantFields}${foot("", false)}</div>`;
  }
  if (l.kind === "tenant") {
    const t = l.isNew ? { name: "", domains: [] } : tenant(l.id);
    const n = data.profiles.filter((p) => p.tenant === l.id).length;
    return `<div class="dialog"><h4>${l.isNew ? "A new tenant" : `Edit the tenant ${esc(t.name)}`}</h4>
      <label>Name <input name="name" value="${esc(t.name)}" placeholder="Contoso"></label>
      <label>Domains <input name="domains" value="${esc(t.domains.join(", "))}" placeholder="contoso.com, contoso.onmicrosoft.com"></label>
      <div class="hint">Profiles whose account is on one of these land here, unless you put them elsewhere.</div>
      ${foot(l.isNew ? "" : `Delete the tenant${n ? ` (its ${n} go to Ungrouped)` : ""}`, l.isNew)}</div>`;
  }
  if (l.kind === "rule") {
    const r = l.isNew ? { pattern: "", dir: current()?.dir } : data.rules[l.index];
    return `<div class="dialog"><h4>${l.isNew ? "A new link rule" : "Edit the link rule"}</h4>
      <label>Links like <input name="pattern" value="${esc(r.pattern)}" placeholder="dev.azure.com/contoso/*"></label>
      <div class="hint">Leave out https://. A host (*.contoso.com) takes every page there; * alone takes every link.</div>
      <label>Open in <select name="dir">${data.profiles.map((p) => opt(p.dir, r.dir, `${p.name} · ${tenant(p.tenant).name}`)).join("")}</select></label>
      ${foot(l.isNew ? "" : "Delete the rule", l.isNew)}</div>`;
  }
  // ask: delete a profile
  const p = profile(l.dir);
  const why = p.dir === "Default" ? `${data.browser}'s first profile can't be deleted here`
    : p.pending ? "Sign in to it once, so the browser lists it"
    : data.running ? `Quit ${data.browser} first (every window): it rewrites its profile list when it quits` : "";
  return `<div class="dialog"><h4>Delete ${esc(p.name)}?</h4>
    <button class="opt" data-f="hide"><b>Hide it in thumbdeck <kbd>h</kbd></b><small>The browser keeps it; Space h shows hidden ones, dd on one brings it back.</small></button>
    <button class="opt bad" data-f="remove"${why ? " disabled" : ""}><b>Delete it from ${esc(data.browser)} <kbd>X</kbd></b><small>${esc(why || `${p.dir} with its bookmarks, passwords, cookies and history goes to the Trash; its rules go too.`)}</small></button>
    <div class="foot"><span class="spacer"></span><button data-f="cancel">Never mind <kbd>Esc</kbd></button></div></div>`;
}

function openLayer(l) {
  layer = l;
  $("layer").innerHTML = layerHtml();
  $("layer").hidden = false;
  td.keys.use(l.kind === "ask" ? "ask" : "form");
  td.keys.take();
  $("layer").querySelector("input, select")?.focus();
}

function closeLayer() {
  layer = null;
  $("layer").hidden = true;
  $("layer").innerHTML = "";
  td.keys.use(page === "rules" ? "rules" : "list");
}

const field = (name) => $("layer").querySelector(`[name="${name}"]`)?.value ?? "";
const tenantChoice = () => ({ tenant: field("tenant"), newTenant: { name: field("tname"), domains: field("tdomains") } });

async function call(method, params, done) {
  try {
    const r = await td.backend.call(method, params);
    if (done) td.ui.say(typeof done === "function" ? done(r) : done);
    return r ?? true;
  } catch (e) {
    td.ui.say(e.message, { error: true });
    return null;
  } finally {
    await load();
  }
}

async function saveLayer() {
  const l = layer;
  if (l.kind === "profile") {
    const p = { label: field("label"), account: field("account"), role: field("role"), shortcuts: field("shortcuts"),
      color: $("layer").querySelector('.sw [aria-pressed="true"]')?.dataset.color ?? "", ...tenantChoice() };
    if (l.isNew) {
      if (!p.label.trim()) return td.ui.say("A profile needs a name", { error: true });
      closeLayer();
      const dir = await call("create", p, (d) => `${data.browser} opened ${d}: sign in there`);
      if (dir) {
        cursor = dir;
        render();
      }
    } else {
      closeLayer();
      await call("edit", { dir: l.dir, ...p }, "saved");
    }
  } else if (l.kind === "move") {
    const c = tenantChoice();
    closeLayer();
    if (c.tenant === "new") await call("edit", { dir: cursor, ...c }, "moved");
    else await call("move", { dir: cursor, tenant: c.tenant }, "moved");
  } else if (l.kind === "tenant") {
    if (!field("name").trim()) return td.ui.say("A tenant needs a name", { error: true });
    const params = { id: l.isNew ? null : l.id, name: field("name"), domains: field("domains") };
    closeLayer();
    await call("saveTenant", params, "saved the tenant");
  } else if (l.kind === "rule") {
    if (!field("pattern").trim()) return td.ui.say("A rule needs a pattern", { error: true });
    const params = { index: l.isNew ? null : l.index, pattern: field("pattern"), dir: field("dir") };
    closeLayer();
    await call("saveRule", params, "saved the rule");
    if (l.isNew) {
      ruleCursor = data.rules.length - 1;
      render();
    }
  }
}

async function deleteFromLayer() {
  const l = layer;
  closeLayer();
  if (l.kind === "profile") return openLayer({ kind: "ask", dir: l.dir });
  if (l.kind === "tenant") return deleteTenant(l.id);
  if (l.kind === "rule") return deleteRule(l.index);
}

async function deleteTenant(id) {
  const t = tenant(id);
  if (!(await td.ui.confirm(`Delete the tenant ${t.name}? Its profiles stay in the browser and move to Ungrouped.`, { yes: "Delete" }))) return;
  if (only === id) only = null;
  await call("removeTenant", { id }, `deleted ${t.name}`);
}

async function deleteRule(index) {
  if (!(await td.ui.confirm(`Delete the rule ${data.rules[index].pattern}?`, { yes: "Delete" }))) return;
  await call("removeRule", { index }, "deleted the rule");
}

async function ask(action) {
  const p = profile(layer.dir);
  if (action === "hide") {
    closeLayer();
    return call("hide", { dir: p.dir, hidden: true }, `${p.name} is hidden (Space h shows hidden ones)`);
  }
  if (action === "remove") {
    if ($("layer").querySelector('[data-f="remove"]').disabled) return td.ui.say($("layer").querySelector('[data-f="remove"] small').textContent, { error: true });
    closeLayer();
    return call("remove", { dir: p.dir }, (r) => `deleted ${p.name}${r.trashed ? " (its folder is in the Trash)" : ""}`);
  }
  closeLayer();
}

// ------------------------------------------------------------ keys and clicks

function move(by, to) {
  const r = rows();
  if (!r.length) return;
  const i = r.findIndex((p) => p.dir === cursor);
  cursor = r[Math.max(0, Math.min(r.length - 1, to ?? i + by))].dir;
  render();
}

function moveRule(by, to) {
  ruleCursor = Math.max(0, Math.min(data.rules.length - 1, to ?? ruleCursor + by));
  render();
}

function switchPage() {
  page = page === "list" ? "rules" : "list";
  td.keys.use(page);
  render();
}

function startSearch() {
  const s = $("search");
  s.hidden = false;
  s.value = words;
  s.focus();
}
$("search").addEventListener("input", () => {
  words = $("search").value.trim();
  const r = rows();
  if (!r.some((p) => p.dir === cursor)) cursor = r[0]?.dir ?? null;
  render();
});
$("search").addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    $("search").blur();
    if (!words) $("search").hidden = true;
  } else if (e.key === "Escape") {
    words = "";
    $("search").hidden = true;
    $("search").blur();
    render();
  }
});

async function openShortcut(k) {
  const p = current();
  const s = p?.shortcuts[k];
  if (!s) return td.ui.say(p ? `${p.name} has no shortcut '${"abcdefghijklmnopqrstuvwxyz"[k]} (i adds shortcuts)` : "No profile");
  await call("open", { dir: p.dir, url: s[1] }, `${s[0]} in ${p.name}`);
}

async function onList(action, arg) {
  const p = current();
  switch (action) {
    case "down": return move(1);
    case "up": return move(-1);
    case "first": return move(0, 0);
    case "last": return move(0, rows().length - 1);
    case "open": return p && call("open", { dir: p.dir }, `${p.name}${p.open ? "" : ` · ${data.browser} opens it`}`);
    case "jump": {
      const k = "abcdefghijklmnopqrstuvwxyz".indexOf(String(arg ?? "").toLowerCase());
      return k < 0 ? td.ui.say("A shortcut is 'a, 'b, 'c…") : openShortcut(k);
    }
    case "search": return startSearch();
    case "filter": {
      const ids = [null, ...data.tenants.map((t) => t.id)];
      only = ids[(ids.indexOf(only) + 1) % ids.length];
      const r = rows();
      if (!r.some((x) => x.dir === cursor)) cursor = r[0]?.dir ?? null;
      return render();
    }
    case "fold-all":
      for (const t of data.tenants) folded.add(t.id);
      return render();
    case "unfold-all":
      folded.clear();
      return render();
    case "fold-toggle": {
      if (!p) return;
      folded.has(p.tenant) ? folded.delete(p.tenant) : folded.add(p.tenant);
      if (folded.has(p.tenant)) cursor = rows().find((x) => x.tenant !== p.tenant)?.dir ?? cursor;
      return render();
    }
    case "new": return openLayer({ kind: "profile", isNew: true });
    case "edit": return p && openLayer({ kind: "profile", dir: p.dir });
    case "move": return p && openLayer({ kind: "move" });
    case "delete":
      if (!p) return;
      if (p.hidden) return call("hide", { dir: p.dir, hidden: false }, `${p.name} is back`);
      return openLayer({ kind: "ask", dir: p.dir });
    case "new-tenant": return openLayer({ kind: "tenant", isNew: true });
    case "edit-tenant":
      if (!p) return;
      if (p.tenant === "none") return td.ui.say("Ungrouped isn't a tenant: Space n makes one, Space m moves the profile there");
      return openLayer({ kind: "tenant", id: p.tenant });
    case "hidden":
      showHidden = !showHidden;
      return render();
    case "yank":
      if (!p?.email) return td.ui.say("No account");
      try {
        await (td.ui.copy ? td.ui.copy(p.email) : navigator.clipboard.writeText(p.email));
      } catch {
        return td.ui.say("couldn't copy", { error: true });
      }
      return td.ui.say(`copied ${p.email}`);
    case "refresh": return load();
    case "next-list": return switchPage();
  }
}

async function onRules(action) {
  switch (action) {
    case "down": return moveRule(1);
    case "up": return moveRule(-1);
    case "first": return moveRule(0, 0);
    case "last": return moveRule(0, data.rules.length - 1);
    case "open": return data.rules.length && openLayer({ kind: "rule", index: ruleCursor });
    case "new":
      if (!data.profiles.length) return td.ui.say("There's no profile to open links in yet");
      return openLayer({ kind: "rule", isNew: true });
    case "delete": return data.rules.length && deleteRule(ruleCursor);
    case "rule-down":
    case "rule-up": {
      const to = await call("moveRule", { index: ruleCursor, by: action === "rule-down" ? 1 : -1 });
      if (typeof to === "number") ruleCursor = to;
      return render();
    }
    case "try": return $("try")?.focus();
    case "next-list": return switchPage();
  }
}

td.on("key", ({ action, arg }) => {
  if (layer?.kind === "ask") return ask(action);
  if (layer) return action === "save" ? saveLayer() : action === "leave" ? closeLayer() : null;
  return page === "list" ? onList(action, arg) : onRules(action);
});

// In a field keys go to it, not to the keymap: the dialog's own Enter, Ctrl+Enter and Esc
$("layer").addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    e.preventDefault();
    closeLayer();
  } else if (e.key === "Enter" && (e.ctrlKey || e.metaKey || e.target.tagName === "INPUT")) {
    e.preventDefault();
    saveLayer();
  }
});
$("layer").addEventListener("change", (e) => {
  if (e.target.name === "tenant") $("layer").querySelectorAll(".newt").forEach((x) => (x.hidden = e.target.value !== "new"));
});
$("layer").addEventListener("click", (e) => {
  if (e.target === $("layer")) return closeLayer();
  const sw = e.target.closest("[data-color]");
  if (sw) return sw.parentElement.querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", String(b === sw)));
  const f = e.target.closest("[data-f]")?.dataset.f;
  if (f === "save") saveLayer();
  else if (f === "cancel") closeLayer();
  else if (f === "delete") deleteFromLayer();
  else if (f === "hide" || f === "remove") ask(f);
});

document.addEventListener("input", (e) => {
  if (e.target.id !== "try") return;
  tryUrl = e.target.value.trim();
  tried();
});
document.addEventListener("keydown", (e) => {
  if (e.target.id === "try" && (e.key === "Enter" || e.key === "Escape")) e.target.blur();
});

document.addEventListener("click", (e) => {
  if (layer || e.target.closest("#layer")) return;
  const el = e.target.closest("[data-page],[data-only],[data-act],[data-fold],[data-dir],[data-short],[data-rule]");
  if (!el) return;
  const d = el.dataset;
  if (d.page) { if (d.page !== page) switchPage(); }
  else if (d.only !== undefined) { only = only === d.only ? null : d.only; render(); }
  else if (d.act) (page === "list" ? onList : onRules)(d.act);
  else if (d.fold) { folded.has(d.fold) ? folded.delete(d.fold) : folded.add(d.fold); render(); }
  else if (d.short !== undefined) openShortcut(+d.short);
  else if (d.dir) { cursor = d.dir; render(); }
  else if (d.rule !== undefined) { ruleCursor = +d.rule; render(); }
});
document.addEventListener("dblclick", (e) => {
  if (e.target.closest("[data-dir]")) onList("open");
  else if (e.target.closest("[data-rule]")) onRules("open");
});

td.backend.on("changed", load);
td.on("shown", load);
setInterval(() => !layer && page === "list" && render(), 60_000); // the ages
if (older(td.context.thumbdeck, "0.8.0")) td.ui.say("Chrome looks its best in thumbdeck 0.8 or newer: update thumbdeck");
load();
