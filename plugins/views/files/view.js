// The Files view: the folder above, this folder and a preview of the highlighted entry, in tabs.
// The backend reads and changes the files (backend.js); this draws them and takes the keys.
import { ago, bulkPlan, fuzzy, human, quote, sortEntries, tilde } from "./files.js";

const td = window.thumbdeck;
const esc = td.escape;
const $ = (id) => document.getElementById(id);
const call = (method, params) => td.backend.call(method, params);
const join = (dir, name) => (dir === "/" ? `/${name}` : `${dir}/${name}`);
const dirOf = (path) => path.replace(/\/[^/]+$/, "") || "/";
const nameOf = (path) => path.split("/").pop();

let settings = { follow: true, hidden: false, editor: "nvim", bookmarks: {} };
let home = "";
let marks = {}; // bookmarks set with m (kept in storage), over the settings' ones
const tabs = []; // { dir, cursor: Map(dir -> name) }
let tab = 0;
let listing = null; // the current folder: { dir, parent, entries, git }
let parentListing = null;
let shown = []; // the entries shown, in order
let filter = "";
let filtering = false;
let sort = "name";
let hidden = false;
const selected = new Set(); // paths
let anchor = null; // visual selection's start (a path)
let clip = null; // { mode: "copy" | "cut", paths }
let renaming = null; // a path
let usage = null; // { dir, total, items, cursor }
let layer = null; // "find" | "grep" | "buffer" | "command" | "make"
let undoLabel = null;
let unwatch = null;

const T = () => tabs[tab];
const cursorName = () => T().cursor.get(T().dir);
const current = () => shown.find((e) => e.name === cursorName()) ?? shown[0];
const targets = () => (selected.size ? shown.filter((e) => selected.has(e.path)) : current() ? [current()] : []);
const bookmarks = () => ({ ...(settings.bookmarks ?? {}), ...marks });
const expand = (p) => (p === "~" ? home : p.startsWith("~/") ? home + p.slice(1) : p);

function say(text, error) {
  td.ui.say(text, error ? { error: true } : undefined);
}
async function act(fn, done) {
  try {
    const r = await fn();
    if (done) say(typeof done === "function" ? done(r) : done);
    return r;
  } catch (e) {
    say(e.message, true);
    return undefined;
  } finally {
    undoLabel = await call("undoLabel").catch(() => null);
  }
}

// ------------------------------------------------------------ reading

async function load(keepPreview) {
  const dir = T().dir;
  try {
    listing = await call("list", { dir });
    $("error").hidden = true;
  } catch (e) {
    $("error").hidden = false;
    $("error").textContent = e.message;
    listing = { dir, parent: dirOf(dir), entries: [], git: null };
  }
  parentListing = listing.parent ? await call("list", { dir: listing.parent }).catch(() => null) : null;
  arrange();
  render();
  if (!keepPreview) schedulePreview();
  watchDir(dir);
}

function arrange() {
  let list = listing.entries.filter((e) => hidden || !e.hidden);
  if (filter) list = list.filter((e) => fuzzy(filter, e.name));
  shown = sortEntries(list, sort);
  if (!shown.some((e) => e.name === cursorName()) && shown[0]) T().cursor.set(T().dir, shown[0].name);
}

function watchDir(dir) {
  unwatch?.();
  let timer = null;
  try {
    unwatch = td.fs.watch(dir, () => {
      clearTimeout(timer);
      timer = setTimeout(() => !renaming && !layer && T().dir === dir && load(true), 300);
    });
  } catch {
    unwatch = null;
  }
}

// ------------------------------------------------------------ drawing

const COLOR = { dir: "var(--blue)", code: "var(--green)", md: "var(--fg)", image: "var(--purple)", video: "var(--orange)", audio: "var(--orange)", pdf: "var(--red)", csv: "var(--aqua)", zip: "var(--yellow)", file: "var(--grey)" };
function icon(e) {
  const c = COLOR[e.kind] ?? COLOR.file;
  const s = `fill="none" stroke="${c}" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round"`;
  if (e.dir) return `<svg class="ic" viewBox="0 0 16 16"><path ${s} d="M1.5 4.5v8a1 1 0 0 0 1 1h11a1 1 0 0 0 1-1v-6a1 1 0 0 0-1-1H8L6.5 3.5h-4a1 1 0 0 0-1 1z"/></svg>`;
  const inner = { image: '<circle cx="6" cy="7" r="1.3"/><path d="M3.5 12.5l3.5-3.5 2 2 1.5-1.5 2 3"/>', video: '<path d="M6.5 6.5v4l3.5-2z"/>', audio: '<path d="M7 11.5V6.5l4-1v5"/><circle cx="6" cy="11.5" r="1"/>', zip: '<path d="M8 2.5v2M8 6v1.5M8 9v1.5"/>', code: '<path d="M6.5 7l-2 2 2 2M9.5 7l2 2-2 2"/>', pdf: '<path d="M5 8.5h6M5 10.5h6M5 12.5h4"/>', md: '<path d="M5 8.5h6M5 10.5h6M5 12.5h4"/>', csv: '<path d="M4.5 8.5h7M4.5 11h7M8 7v6"/>' }[e.kind] ?? "";
  return `<svg class="ic" viewBox="0 0 16 16"><g ${s}><path d="M3.5 1.5h6l3 3v9a1 1 0 0 1-1 1h-8a1 1 0 0 1-1-1v-11a1 1 0 0 1 1-1z"/>${inner}</g></svg>`;
}
function marked(name) {
  const at = filter ? fuzzy(filter, name) : null;
  if (!at) return esc(name);
  return [...name].map((ch, i) => (at.includes(i) ? `<mark>${esc(ch)}</mark>` : esc(ch))).join("");
}
const gitMark = (g) => (g ? `<span class="g-${g === "•" ? "dot" : g}">${g}</span>` : "");

function row(e, { cur, main } = {}) {
  const sel = selected.has(e.path), cut = clip?.mode === "cut" && clip.paths.includes(e.path);
  const name = main && renaming === e.path ? `<input id="rename" value="${esc(e.name)}" spellcheck="false">`
    : `<span class="nm ${e.dir ? "dir" : ""} ${e.hidden || e.git === "I" ? "dim" : ""}">${main ? marked(e.name) : esc(e.name)}${e.dir ? "/" : ""}${e.link ? ' <span class="ln">→</span>' : ""}</span>`;
  const meta = main ? `<span class="meta"><span>${e.dir ? (e.count ?? "") : human(e.size)}</span><span class="age">${ago(e.mtime)}</span></span>` : "<span></span>";
  return `<div class="row${cur ? " cur" : ""}${sel ? " sel" : ""}${cut ? " cut" : ""}" data-path="${esc(e.path)}"><span class="mk">${sel ? "●" : gitMark(e.git)}</span>${icon(e)}${name}${meta}</div>`;
}

function render() {
  const t = T();
  $("tabs").innerHTML = tabs.map((x, i) => `<div class="tab" aria-selected="${i === tab}" data-tab="${i}">${esc(nameOf(x.dir) || "/")}</div>`).join("") +
    `<span class="spacer"></span><span class="hint">:tabnew · ]b [b switch · :tabclose</span>`;
  const shownPath = tilde(t.dir, home);
  const parts = shownPath === "/" ? [""] : shownPath.split("/");
  // "/" at the start is the root, so no separator after it
  const segs = parts.map((p, i) => `${i > 0 && parts[0] !== "" ? '<span class="sl">/</span>' : i > 1 ? '<span class="sl">/</span>' : ""}<span class="seg${i === parts.length - 1 ? " last" : ""}" data-depth="${parts.length - 1 - i}">${esc(p || "/")}</span>`).join("");
  const bms = Object.entries(bookmarks()).slice(0, 6).map(([k, p]) => `<span data-bm="${esc(k)}" title="${esc(p)}"><b>'${esc(k)}</b>${esc(nameOf(expand(p)) || "~")}</span>`).join("");
  $("path").innerHTML = `${segs}${listing?.git ? `<span class="branch">⎇ ${esc(listing.git.branch)}</span>` : ""}<span class="spacer"></span>` +
    (filtering || filter ? `<input id="filter" value="${esc(filter)}" placeholder="filter…" spellcheck="false">` : "") + `<span class="bm">${bms}</span>`;
  if (filtering) {
    const f = $("filter");
    f.focus();
    f.setSelectionRange(f.value.length, f.value.length);
  }

  $("cols").hidden = !!usage;
  $("usage").hidden = !usage;
  if (usage) renderUsage();
  else {
    const cur = current();
    $("parent").innerHTML = parentListing
      ? sortEntries(parentListing.entries.filter((e) => hidden || !e.hidden), sort).map((e) => row(e, { cur: e.path === t.dir })).join("")
      : `<div class="empty">${esc(t.dir)}</div>`;
    $("main").innerHTML = shown.length ? shown.map((e) => row(e, { cur: e === cur, main: true })).join("") : `<div class="empty">${filter ? "Nothing matches." : "Empty folder."}</div>`;
    $("main").querySelector(".row.cur")?.scrollIntoView({ block: "nearest" });
    $("parent").querySelector(".row.cur")?.scrollIntoView({ block: "nearest" });
    if (renaming) {
      const r = $("rename");
      if (r) {
        r.focus();
        const dot = r.value.lastIndexOf(".");
        r.setSelectionRange(0, dot > 0 ? dot : r.value.length);
      }
    }
  }
  const mode = anchor ? "VISUAL: j / k extend, y copies, d deletes, c renames" : "";
  $("status").innerHTML = [
    `<span>${shown.length} items${hidden ? " · hidden shown" : ""} · by ${sort}</span>`,
    selected.size ? `<span class="sel">${selected.size} selected${anchor ? " (V)" : ""}</span>` : "",
    clip ? `<span class="clip">${clip.mode === "cut" ? "cut" : "copied"}: ${clip.paths.length === 1 ? esc(nameOf(clip.paths[0])) : `${clip.paths.length} items`} · p pastes</span>` : "",
    undoLabel ? `<span>u undoes the ${esc(undoLabel)}</span>` : "",
    mode ? `<span class="clip">${mode}</span>` : "",
  ].filter(Boolean).join("");
  td.ui.status(clip ? `${clip.paths.length} ${clip.mode === "cut" ? "cut" : "copied"}` : null);
}

// ------------------------------------------------------------ previews

const KW = /^(import|from|export|default|const|let|var|await|async|new|return|class|private|public|constructor|function|def|if|elif|else|for|while|in|of|try|catch|except|raise|throw|local|require|true|false|null|None|True|False|fn|pub|use|struct|impl|match|type|interface)$/;
function highlight(line, kind) {
  if (kind === "md") {
    if (/^#/.test(line)) return `<span class="tk-h">${esc(line)}</span>`;
    return esc(line).replace(/`([^`]+)`/g, '<span class="tk-s">`$1`</span>');
  }
  const re = /(\/\/.*$|#(?![{\[]).*$|--.*$)|("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)|(\b\d+(?:\.\d+)?\b)|(\b[A-Za-z_]\w*(?=\())|(\b[A-Za-z_]\w*\b)/g;
  let out = "", last = 0, m;
  while ((m = re.exec(line))) {
    out += esc(line.slice(last, m.index));
    const [t, com, str, num, fnName, word] = m;
    if (com) out += `<span class="tk-c">${esc(t)}</span>`;
    else if (str) out += `<span class="tk-s">${esc(t)}</span>`;
    else if (num) out += `<span class="tk-n">${t}</span>`;
    else if (fnName) out += KW.test(fnName) ? `<span class="tk-k">${fnName}</span>` : `<span class="tk-f">${fnName}</span>`;
    else out += KW.test(word) ? `<span class="tk-k">${word}</span>` : word;
    last = re.lastIndex;
  }
  return out + esc(line.slice(last));
}
const codeLines = (text, kind, max = 600) => `<pre class="code">${text.split("\n").slice(0, max).map((l, i) => `<div class="ln2"><span>${i + 1}</span><span>${highlight(l.slice(0, 400), kind)}</span></div>`).join("")}</pre>`;
function diffLines(diff) {
  const out = [];
  let n = 0;
  for (const l of diff.split("\n")) {
    if (/^(diff |index |--- |\+\+\+ )/.test(l)) continue;
    if (l.startsWith("@@")) {
      n = +(/\+(\d+)/.exec(l)?.[1] ?? 1);
      out.push(`<div class="ln2 hunk"><span>…</span><span>${esc(l)}</span></div>`);
    } else if (l.startsWith("+")) out.push(`<div class="ln2 add"><span>${n++}</span><span>${highlight(l.slice(1), "code")}</span></div>`);
    else if (l.startsWith("-")) out.push(`<div class="ln2 del"><span>−</span><span>${highlight(l.slice(1), "code")}</span></div>`);
    else if (l) out.push(`<div class="ln2"><span>${n++}</span><span>${highlight(l.slice(1), "code")}</span></div>`);
  }
  return `<pre class="code">${out.join("")}</pre>`;
}
const MIME = { svg: "image/svg+xml", jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif", webp: "image/webp", bmp: "image/bmp", ico: "image/x-icon", avif: "image/avif" };
const kb = (k) => `<kbd style="margin:0">${k}</kbd>`;
const duration = (s) => (s ? `${Math.floor(s / 3600) ? Math.floor(s / 3600) + ":" : ""}${String(Math.floor((s % 3600) / 60)).padStart(Math.floor(s / 3600) ? 2 : 1, "0")}:${String(Math.floor(s % 60)).padStart(2, "0")}` : "");

let previewTimer = null, previewFor = null, wholeFile = false;
const previewCache = new Map();
function schedulePreview() {
  clearTimeout(previewTimer);
  const e = current();
  if (!e) return ($("preview").innerHTML = "");
  previewTimer = setTimeout(() => showPreview(e), previewCache.has(e.path + e.mtime) ? 0 : 90);
}
async function showPreview(e) {
  previewFor = e.path;
  const key = e.path + e.mtime;
  let p = previewCache.get(key);
  if (!p) {
    p = await call("preview", { path: e.path }).catch((err) => ({ ...e, type: "error", problem: err.message }));
    previewCache.set(key, p);
    if (previewCache.size > 60) previewCache.delete(previewCache.keys().next().value);
  }
  if (previewFor !== e.path || usage) return;
  $("preview").innerHTML = previewHtml(p);
}
function previewHtml(p) {
  const head = (extra) => `<div class="phead"><div class="t">${icon(p)}<span>${esc(p.name)}${p.dir ? "/" : ""}</span>${p.git ? gitMark(p.git) : ""}</div><div class="s">${extra}</div></div>`;
  if (p.type === "error") return head("") + `<div class="empty">${esc(p.problem)}</div>`;
  if (p.type === "dir") {
    const list = sortEntries((p.entries ?? []).filter((e) => hidden || !e.hidden), sort);
    return head(`${list.length} item${list.length === 1 ? "" : "s"}${p.repo ? ` · <span class="td-purple">⎇ ${esc(p.repo.branch)}</span>` : ""}${p.problem ? ` · ${esc(p.problem)}` : ""}`) +
      `<div class="pbody" style="padding:4px 6px">${list.length ? list.slice(0, 300).map((e) => row(e)).join("") : '<div class="empty">Empty folder.</div>'}</div>`;
  }
  const base = `${human(p.size)} · changed ${ago(p.mtime)} ago`;
  if (p.diff && !wholeFile) return head(`${base} · <span class="td-yellow">changed</span> · ${kb("l")} the whole file · ${kb("gd")} review`) + `<div class="pbody">${diffLines(p.diff)}</div>`;
  switch (p.type) {
    case "image":
      return head(`${base}`) + `<div class="pbody">${p.data ? `<div class="pimg"><img alt="" src="data:${MIME[p.name.split(".").pop().toLowerCase()] ?? "image/png"};base64,${p.data}"></div>` : '<div class="empty">Too big to preview: o opens it.</div>'}</div>`;
    case "video":
    case "audio":
      return head(`${base}${p.duration ? ` · ${duration(p.duration)}` : ""}${p.res ? ` · ${esc(p.res)}` : ""}`) + `<div class="pbody"><dl class="facts">${p.duration ? `<dt>Length</dt><dd>${duration(p.duration)}</dd>` : ""}${p.res ? `<dt>Video</dt><dd>${esc(p.res)}</dd>` : ""}<dt>Open</dt><dd>${kb("gx")} with the default player</dd></dl>${p.duration ? "" : '<div class="empty">Install ffmpeg to see its length.</div>'}</div>`;
    case "pdf":
      return head(`${base}${p.info?.Pages ? ` · ${esc(p.info.Pages)} pages` : ""}`) + `<div class="pbody">${p.info ? `<dl class="facts">${Object.entries(p.info).map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join("")}</dl>` : ""}${p.text ? `<div class="plain">${esc(p.text)}</div>` : '<div class="empty">Install poppler (pdfinfo, pdftotext) to see what it says.</div>'}</div>`;
    case "zip":
      return head(`${base}${p.total ? ` · ${p.total} entries` : ""}`) + `<div class="pbody">${p.entries ? `<pre class="code">${p.entries.map((e) => `<div class="ln2"><span></span><span>${esc(e)}</span></div>`).join("")}</pre>` : `<div class="empty">${esc(p.problem ?? "")}</div>`}</div>`;
    case "csv": {
      if (!p.text) break;
      const sep = p.name.endsWith(".tsv") ? "\t" : ",";
      const rows = p.text.split("\n").filter(Boolean).slice(0, 200).map((l) => l.split(sep));
      return head(`${base} · ${rows.length - 1}${p.cut ? "+" : ""} rows`) + `<div class="pbody"><table class="ptable"><tr>${rows[0].map((x) => `<th>${esc(x)}</th>`).join("")}</tr>${rows.slice(1).map((r) => `<tr>${r.map((x) => `<td class="${/^-?[\d.,]+$/.test(x) ? "num" : ""}">${esc(x)}</td>`).join("")}</tr>`).join("")}</table></div>`;
    }
  }
  if (p.text !== undefined) {
    const lines = p.text.split("\n").length;
    return head(`${base} · ${lines}${p.cut ? "+" : ""} lines${p.git === "U" ? ' · <span class="td-green">new</span>' : ""}`) + `<div class="pbody">${codeLines(p.text, p.type === "md" ? "md" : "code")}</div>`;
  }
  return head(base) + `<div class="pbody"><dl class="facts"><dt>Type</dt><dd>binary</dd><dt>Open</dt><dd>${kb("gx")} with the default app</dd></dl></div>`;
}

// ------------------------------------------------------------ disk usage

async function openUsage(dir) {
  usage = { dir, loading: true, items: [], total: 0, cursor: 0 };
  td.keys.use("usage");
  render();
  const r = await call("usage", { dir, hidden }).catch((e) => (say(e.message, true), null));
  if (!usage || usage.dir !== dir) return;
  usage = r ? { ...r, cursor: 0 } : null;
  if (!usage) td.keys.use("list");
  render();
}
function renderUsage() {
  const u = usage;
  if (u.loading) return ($("usage").innerHTML = `<div class="total">Adding up ${esc(tilde(u.dir, home))}…</div>`);
  const max = u.items[0]?.size || 1;
  $("usage").innerHTML = `<div class="total"><span><b>${esc(tilde(u.dir, home))}</b> · ${human(u.total)} in ${u.items.length} items${u.partial ? " (some folders couldn't be read)" : ""}</span><span>l into a folder · h up · dd to the Trash · Esc back</span></div>` +
    u.items.map((e, i) => `<div class="row${i === u.cursor ? " cur" : ""}" data-usage="${i}">${icon(e)}<span class="nm ${e.dir ? "dir" : ""}">${esc(e.name)}${e.dir ? "/" : ""}</span><span class="sz">${human(e.size)}</span><span class="bar"><i style="width:${Math.max(1.5, (e.size / max) * 100)}%;background:${COLOR[e.kind] ?? COLOR.file}"></i></span></div>`).join("");
  $("usage").querySelector(".row.cur")?.scrollIntoView({ block: "nearest" });
}
async function onUsage(action) {
  const u = usage;
  if (u.loading && action !== "leave") return;
  const e = u.items[u.cursor];
  switch (action) {
    case "down": u.cursor = Math.min(u.items.length - 1, u.cursor + 1); break;
    case "up": u.cursor = Math.max(0, u.cursor - 1); break;
    case "first": u.cursor = 0; break;
    case "last": u.cursor = u.items.length - 1; break;
    case "open": if (e?.dir) return openUsage(e.path); break;
    case "parent": if (u.dir !== "/") return openUsage(dirOf(u.dir)); break;
    case "delete":
      if (e) await act(() => call("trash", { paths: [e.path] }), `${e.name} (${human(e.size)}) is in the Trash · u brings it back`);
      return openUsage(u.dir);
    case "undo":
      await act(() => call("undo"), (l) => `undid the ${l}`);
      return openUsage(u.dir);
    case "refresh": return openUsage(u.dir);
    case "leave":
      usage = null;
      td.keys.use("list");
      return go(u.dir);
  }
  render();
}

// ------------------------------------------------------------ moving around

function setCursor(name) {
  T().cursor.set(T().dir, name);
  wholeFile = false;
  if (anchor) {
    const a = shown.findIndex((e) => e.path === anchor), b = shown.findIndex((e) => e.name === name);
    selected.clear();
    for (const e of shown.slice(Math.min(a, b), Math.max(a, b) + 1)) selected.add(e.path);
  }
  render();
  schedulePreview();
}
function move(by, to) {
  if (!shown.length) return;
  const i = shown.indexOf(current());
  setCursor(shown[Math.max(0, Math.min(shown.length - 1, to ?? i + by))].name);
}
async function go(dir, focus) {
  if (T().dir !== dir) {
    filter = "";
    filtering = false;
    selected.clear();
    anchor = null;
  }
  T().dir = dir;
  if (focus) T().cursor.set(dir, focus);
  await load();
}
function parent() {
  const d = T().dir;
  if (d === "/") return;
  go(dirOf(d), nameOf(d));
}
async function open() {
  const e = current();
  if (!e) return;
  if (e.dir) return go(e.path);
  if (!wholeFile) {
    wholeFile = true;
    previewCache.delete(e.path + e.mtime);
    return showPreview(e);
  }
}

// ------------------------------------------------------------ changing files

function copyOrCut(mode) {
  const items = targets();
  if (!items.length) return;
  clip = { mode, paths: items.map((e) => e.path) };
  selected.clear();
  if (anchor) (anchor = null), td.keys.use("list");
  say(`${mode === "cut" ? "cut" : "copied"} ${items.length === 1 ? items[0].name : `${items.length} items`}: go somewhere and press p`);
  render();
}
async function paste() {
  if (!clip) return say("Nothing to paste: y copies, x cuts");
  const c = clip;
  const made = await act(() => call("paste", { paths: c.paths, to: T().dir, move: c.mode === "cut" }), (r) => `${c.mode === "cut" ? "moved" : "copied"} ${r.length} here`);
  if (!made) return;
  if (c.mode === "cut") clip = null;
  if (made[0]) T().cursor.set(T().dir, nameOf(made[0]));
  await load();
}
async function trash() {
  const items = targets();
  if (!items.length) return;
  const i = shown.indexOf(current());
  const next = shown.slice(i + 1).find((e) => !items.includes(e)) ?? shown.slice(0, i).reverse().find((e) => !items.includes(e));
  const res = await act(() => call("trash", { paths: items.map((e) => e.path) }), () => `${items.length === 1 ? items[0].name : `${items.length} items`} in the Trash · p elsewhere moves ${items.length === 1 ? "it" : "them"} there, u brings ${items.length === 1 ? "it" : "them"} back`);
  if (res === undefined) return;
  // Like vim's dd, what's deleted is in the register: p puts it where you are
  clip = res.moved?.length ? { mode: "cut", paths: res.moved } : clip && { ...clip, paths: clip.paths.filter((p) => !items.some((e) => e.path === p)) };
  selected.clear();
  if (anchor) (anchor = null), td.keys.use("list");
  if (next) T().cursor.set(T().dir, next.name);
  await load();
}
async function undo() {
  await act(() => call("undo"), (l) => `undid the ${l}`);
  // what the register held may be gone (back where it was)
  if (clip && !(await call("exists", { path: clip.paths[0] }).catch(() => true))) clip = null;
  await load();
}
function startRename() {
  const e = current();
  if (!e) return;
  renaming = e.path;
  render();
}
async function finishRename(save) {
  const path = renaming;
  const value = $("rename")?.value.trim();
  renaming = null;
  if (save && value && value !== nameOf(path)) {
    const dest = await act(() => call("rename", { path, name: value }), `renamed to ${value}`);
    if (dest) T().cursor.set(T().dir, value);
    await load();
  } else render();
}

// ------------------------------------------------------------ dialogs (find, grep, the rename buffer, a command, a new file)

let found = [], foundCursor = 0, findTimer = null, makeFolder = false;
function openLayer(kind, extra = {}) {
  layer = kind;
  makeFolder = !!extra.folder;
  const dir = tilde(T().dir, home);
  const html = {
    find: () => dialog("find", "a file's name, fuzzy", `under ${dir}`, "↑ ↓ move · Enter goes there · Ctrl+g searches inside files instead · Esc closes"),
    grep: () => dialog("grep", "text inside the files", `under ${dir}`, "↑ ↓ move · Enter goes there · Ctrl+e opens the editor at the line · Ctrl+f finds by name instead · Esc closes"),
    command: () => dialog("!", "a command; {} is the files (otherwise they go at the end)", `on ${targets().length} in ${dir}`, "Enter runs it in thumbdeck (output in a tab) · Esc closes"),
    make: () => dialog(extra.folder ? "new folder" : "new file", "its name", `in ${dir}`, "Enter makes it · Esc closes"),
    buffer: () => bufferHtml(extra.names),
  }[kind]();
  $("layer").innerHTML = html;
  $("layer").hidden = false;
  layer === "buffer" ? $("buf").focus() : $("q").focus();
  td.keys.use("text");
  found = [];
  foundCursor = 0;
  if (kind === "find") search();
}
const dialog = (label, placeholder, where, foot) => `<div class="dlg"><div class="inp"><b>${esc(label)}</b><input id="q" placeholder="${esc(placeholder)}" spellcheck="false"><span class="td-muted" style="font-size:11px">${esc(where)}</span></div><div class="res" id="res"></div><div class="foot">${esc(foot)}</div></div>`;
function closeLayer() {
  layer = null;
  $("layer").hidden = true;
  $("layer").innerHTML = "";
  td.keys.use(usage ? "usage" : "list");
  render();
}
async function search() {
  const q = $("q")?.value ?? "";
  const kind = layer;
  const r = await call(kind, { dir: T().dir, q, hidden }).catch((e) => (say(e.message, true), []));
  if (layer !== kind || ($("q")?.value ?? "") !== q) return;
  found = r;
  foundCursor = 0;
  drawFound();
}
function drawFound() {
  const res = $("res");
  if (!res) return;
  res.innerHTML = found.length
    ? found.map((f, i) => `<div class="row${i === foundCursor ? " cur" : ""}" data-found="${i}">${icon(f.kind ? f : { kind: "code" })}<span class="nm ${f.dir ? "dir" : ""}">${esc(f.rel)}${f.dir ? "/" : ""}${f.line ? `<span class="td-muted">:${f.line}</span>` : ""}</span><span class="meta">${f.size && !f.dir ? human(f.size) : ""}</span></div>${f.text ? `<div class="grepline">${highlight(f.text, "code")}</div>` : ""}`).join("")
    : `<div class="empty">${layer === "grep" && !$("q").value ? "Type to search inside the files (ripgrep)." : "Nothing found."}</div>`;
  res.querySelector(".row.cur")?.scrollIntoView({ block: "nearest" });
}
async function pick(edit) {
  const f = found[foundCursor];
  if (!f) return;
  closeLayer();
  if (edit && f.line) return editFile(f.path, f.line);
  await go(f.dir ? f.path : dirOf(f.path), f.dir ? undefined : nameOf(f.path));
  if (f.line) say(`${nameOf(f.path)}:${f.line} · e opens it in the editor`);
}

function bufferHtml(names) {
  return `<div class="buffer"><div class="bar"><b>RENAME</b><span>${esc(tilde(T().dir, home))}</span><span style="margin-left:auto">${names.length} names</span></div>
    <div class="buf"><div class="nums" id="nums">${names.map((_, i) => i + 1).join("\n")}</div><textarea id="buf" spellcheck="false">${esc(names.join("\n"))}</textarea></div>
    <div class="cmd"><span id="bufmsg">Change the names like text: one per line, in the same order.</span><span style="margin-left:auto">${kb("Ctrl+s")} renames them</span><span>${kb("Esc")} leaves them</span></div></div>`;
}
let bufferNames = [];
function startBuffer() {
  const items = selected.size ? shown.filter((e) => selected.has(e.path)) : shown;
  if (!items.length) return;
  bufferNames = items.map((e) => e.name);
  openLayer("buffer", { names: bufferNames });
}
async function saveBuffer() {
  const plan = bulkPlan(bufferNames, $("buf").value, listing.entries.map((e) => e.name));
  if (plan.problem) {
    $("bufmsg").innerHTML = `<span class="problem">Nothing renamed: ${esc(plan.problem)}</span>`;
    return;
  }
  closeLayer();
  if (!plan.changes.length) return say("No names changed");
  await act(() => call("renameMany", { dir: T().dir, changes: plan.changes }), (n) => `renamed ${n} · u undoes`);
  selected.clear();
  await load();
}

async function runCommand(text) {
  const command = (text ?? $("q").value).trim();
  const items = targets();
  if (layer) closeLayer();
  if (!command) return;
  const full = await call("command", { command, paths: items.map((e) => e.path) });
  await act(() => td.run(full, { label: command.split(" ")[0], cwd: T().dir }), `running: ${full}`);
}
async function makeEntry(folder) {
  const name = $("q").value.trim();
  closeLayer();
  if (!name) return;
  const path = await act(() => call("make", { dir: T().dir, name, folder }), `made ${name}`);
  if (path) T().cursor.set(T().dir, name);
  await load();
}

// ------------------------------------------------------------ outside: editor, terminal, apps, review

async function editFile(path, line) {
  const cmd = `${settings.editor || "nvim"} ${line ? `+${line} ` : ""}${quote(path)}`;
  await act(() => td.tmux(cmd, { window: "edit", show: true }), (m) => m || `${nameOf(path)} in ${settings.editor}`);
}
async function review() {
  const e = current();
  if (!e || !listing.git || !["M", "R"].includes(e.git)) return say("v reviews a changed file (M) in a git repo");
  const root = listing.git.root;
  const rel = e.path.slice(root.length + 1);
  td.ui.openReview({
    title: e.name,
    subtitle: `${tilde(dirOf(e.path), home)} · changes since the last commit`,
    diff: async () => (await td.exec(["git", "-C", root, "diff", "HEAD", "--", rel])).stdout,
    viewedKey: `files:${root}`,
    file: (p) => td.fs.read(`${root}/${p}`),
  });
}

// ------------------------------------------------------------ keys

async function onList(action, arg, count) {
  const e = current();
  const n = Math.max(1, count ?? 1);
  const pageRows = Math.max(1, Math.floor($("main").clientHeight / 48));
  switch (action) {
    case "down": case "next-match": return move(n);
    case "up": case "previous-match": return move(-n);
    case "first": return move(0, 0);
    case "last": return move(0, count ? count - 1 : shown.length - 1);
    case "page-down": return move(pageRows * n);
    case "page-up": return move(-pageRows * n);
    case "full-down": return move(2 * pageRows * n);
    case "full-up": return move(-2 * pageRows * n);
    case "open": return open();
    case "main": return e?.dir ? open() : e && editFile(e.path);
    case "parent": return parent();
    case "search":
      filtering = true;
      return render();
    case "find-letter": case "find-letter-back": {
      const back = action === "find-letter-back";
      const at = shown.indexOf(e);
      for (let k = 1; k <= shown.length; k++) {
        const x = shown[(((at + (back ? -k : k)) % shown.length) + shown.length) % shown.length];
        if (x.name.toLowerCase().startsWith(String(arg ?? "").toLowerCase())) return setCursor(x.name);
      }
      return say(`Nothing here starts with ${arg}`);
    }
    case "tick":
      if (anchor) return (anchor = null), say(`${selected.size} selected`), render();
      if (!e) return;
      selected.has(e.path) ? selected.delete(e.path) : selected.add(e.path);
      return move(1);
    case "visual": case "visual-line":
      if (anchor) return endVisual(true);
      if (!e) return;
      anchor = e.path;
      td.keys.use("visual");
      return setCursor(e.name);
    case "yank": case "yank-selection": return copyOrCut("copy");
    case "delete": case "delete-selection": return trash();
    case "paste": case "paste-before": return paste();
    case "undo": return undo();
    case "change": return startRename();
    case "change-selection": return startBuffer();
    case "new": return openLayer("make", { folder: false });
    case "new-above": return openLayer("make", { folder: true });
    case "copy-path": {
      const ps = targets().map((x) => x.path);
      if (ps.length) await act(() => call("copyText", { text: ps.join("\n") }), ps.length === 1 ? `copied ${tilde(ps[0], home)}` : `copied ${ps.length} paths`);
      return;
    }
    case "editor": return e && !e.dir ? editFile(e.path) : say("Space e opens a file in the editor");
    case "outside": return e && act(() => call("open", { path: e.path }), `opening ${e.name}`);
    case "terminal": return act(() => td.tmux(`cd ${quote(T().dir)}`, { window: "files", show: true }), (m) => m || `a terminal in ${tilde(T().dir, home)}`);
    case "diff": return review();
    case "search-wide": return openLayer("find");
    case "grep": return openLayer("grep");
    case "usage": return openUsage(T().dir);
    case "mark": return mark(arg);
    case "jump": return jump(arg);
    case "hidden":
      hidden = !hidden;
      arrange();
      render();
      return schedulePreview();
    case "order":
      sort = { name: "size", size: "date", date: "name" }[sort];
      arrange();
      say(`sorted by ${sort}`);
      return render();
    case "info":
      if (e) say(`${e.name} · ${e.dir ? `${e.count ?? 0} items` : human(e.size)} · ${(e.mode & 0o777).toString(8)} · changed ${new Date(e.mtime).toLocaleString()}`);
      return;
    case "next-tab":
    case "previous-tab":
      tab = (tab + (action === "next-tab" ? n : -n) + tabs.length * n) % tabs.length;
      return load();
    case "refresh":
      previewCache.clear();
      return load();
    case "leave":
      if (anchor) return endVisual(false);
      if (selected.size || filter || clip) {
        selected.clear();
        if (filter) {
          filter = "";
          arrange();
        } else clip = null;
        return render();
      }
      return td.keys.release();
  }
}

/** Leave visual mode: keep the range selected (v again) or drop it (Esc) */
function endVisual(keep) {
  anchor = null;
  if (!keep) selected.clear();
  td.keys.use("list");
  if (keep && selected.size) say(`${selected.size} selected`);
  render();
}

/** :tabnew, :tabclose, :!command (thumbdeck's command line) */
function command({ name, arg }) {
  if (name === "tabnew") {
    tabs.push({ dir: T().dir, cursor: new Map(T().cursor) });
    tab = tabs.length - 1;
    return render();
  }
  if (name === "tabclose") {
    if (tabs.length === 1) return say("It's the only tab");
    tabs.splice(tab, 1);
    tab = Math.min(tab, tabs.length - 1);
    return load();
  }
  if (name === "!") return runCommand(arg);
  if (name === "home") return go(home);
  say(`There's no :${name} in Files (:tabnew, :tabclose, :!command)`);
}

async function mark(k) {
  if (!/^[a-zA-Z]$/.test(k ?? "")) return say("m, then a letter");
  marks = { ...marks, [k]: tilde(T().dir, home) };
  await td.storage.set("bookmarks", marks);
  say(`'${k} goes to ${tilde(T().dir, home)}`);
  render();
}

function jump(k) {
  const to = bookmarks()[k];
  if (!to) return say(`No bookmark '${k} (m${k} sets one)`);
  go(expand(to));
}

td.on("command", command);

td.on("key", ({ action, arg, count }) => {
  if (layer) {
    if (action === "leave") return closeLayer();
    if (action === "save" && layer === "buffer") return saveBuffer();
    return;
  }
  if (usage) return onUsage(action);
  return onList(action, arg, count);
});

// Fields: the filter, renaming, the dialogs
document.addEventListener("input", (e) => {
  if (e.target.id === "filter") {
    filter = e.target.value.trim();
    arrange();
    const pos = e.target.selectionStart;
    render();
    $("filter")?.setSelectionRange(pos, pos);
    schedulePreview();
  } else if (e.target.id === "q" && (layer === "find" || layer === "grep")) {
    clearTimeout(findTimer);
    findTimer = setTimeout(search, layer === "grep" ? 250 : 60);
  } else if (e.target.id === "buf") {
    $("nums").textContent = e.target.value.split("\n").map((_, i) => i + 1).join("\n");
  }
});
document.addEventListener("keydown", (e) => {
  const id = e.target.id;
  if (id === "filter") {
    if (e.key === "Enter" || e.key === "Escape") {
      e.preventDefault();
      if (e.key === "Escape") filter = "";
      filtering = false;
      arrange();
      render();
      schedulePreview();
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      move(e.key === "ArrowDown" ? 1 : -1);
      $("filter")?.focus();
    }
  } else if (id === "rename") {
    if (e.key === "Enter") (e.preventDefault(), finishRename(true));
    else if (e.key === "Escape") (e.preventDefault(), finishRename(false));
  } else if (id === "buf") {
    if ((e.ctrlKey || e.metaKey) && e.key === "s") (e.preventDefault(), saveBuffer());
    else if (e.key === "Escape") (e.preventDefault(), closeLayer());
  } else if (id === "q") {
    if (e.key === "Escape") return e.preventDefault(), closeLayer();
    if (layer === "command" && e.key === "Enter") return e.preventDefault(), runCommand();
    if (layer === "make" && e.key === "Enter") return e.preventDefault(), makeEntry(makeFolder);
    if (layer !== "find" && layer !== "grep") return;
    if (e.key === "ArrowDown" || (e.ctrlKey && e.key === "j")) (foundCursor = Math.min(found.length - 1, foundCursor + 1)), drawFound();
    else if (e.key === "ArrowUp" || (e.ctrlKey && e.key === "k")) (foundCursor = Math.max(0, foundCursor - 1)), drawFound();
    else if (e.ctrlKey && (e.key === "f" || e.key === "g")) {
      const q = $("q").value;
      openLayer(e.key === "f" ? "find" : "grep");
      $("q").value = q;
      search();
    } else if (e.key === "Enter") pick(false);
    else if (e.key === "e" && e.ctrlKey) pick(true);
    else return;
    e.preventDefault();
  }
});
document.addEventListener("focusout", (e) => {
  if (e.target.id === "rename" && renaming) setTimeout(() => renaming && document.activeElement?.id !== "rename" && finishRename(false), 0);
});

// Clicks
document.addEventListener("click", (e) => {
  const el = e.target.closest("[data-path],[data-tab],[data-depth],[data-bm],[data-found],[data-usage]");
  if (!el || e.target.closest("input, textarea")) return;
  const d = el.dataset;
  if (d.found !== undefined) return (foundCursor = +d.found), pick(false);
  if (layer) return;
  if (d.tab !== undefined) return (tab = +d.tab), load();
  if (d.depth !== undefined) {
    let dir = T().dir;
    for (let i = 0; i < +d.depth; i++) dir = dirOf(dir);
    return go(dir);
  }
  if (d.bm) return jump(d.bm);
  if (d.usage !== undefined) return (usage.cursor = +d.usage), render();
  const path = d.path;
  if (dirOf(path) === T().dir) setCursor(nameOf(path));
  else if (el.closest("#parent")) go(dirOf(path), nameOf(path));
  else if (el.closest("#preview")) go(dirOf(path), nameOf(path));
});
document.addEventListener("dblclick", (e) => {
  const el = e.target.closest("#main [data-path]");
  if (el && !renaming) current()?.dir ? open() : onList("outside");
});

// ------------------------------------------------------------ start

td.on("project", (p) => p && settings.follow && go(p.path));
td.on("settings", (s) => {
  settings = s;
  render();
});
td.on("shown", () => listing && load(true));
(async () => {
  settings = await td.settings.get();
  hidden = !!settings.hidden;
  marks = (await td.storage.get("bookmarks")) ?? {};
  home = await call("home");
  const p = await td.projects.selected();
  tabs.push({ dir: settings.follow && p ? p.path : home, cursor: new Map() });
  await load();
  undoLabel = await call("undoLabel").catch(() => null);
})();
