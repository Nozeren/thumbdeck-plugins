// @thumbdeck/check: the checks thumbdeck makes when it loads a plugin (and `thumbdeck plugin
// check` makes), without thumbdeck: for CI. Problems are plain sentences; a plugin with any isn't
// loaded. Keep in step with src-tauri/src/plugins/manifest.rs and keys.rs in thumbdeck.
import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, normalize } from "node:path";
import { parse, TomlError } from "smol-toml";

/** The plugin API versions this checker knows */
export const API = [1, 1];

/** The same key, the same meaning: key -> the action it must run wherever it's bound */
export const RULES = {
  j: "down", k: "up", g: "first", G: "last",
  d: "page-down", u: "page-up",
  l: "open",
  Tab: "next-list", "Shift+Tab": "previous-list",
  v: "review", o: "outside", r: "refresh",
  q: "leave", Escape: "leave",
  S: "setup", "?": "help",
};

/** Keys thumbdeck keeps even while a plugin has the keyboard */
/** Keys a card can't bind: they move between the Overview's cards */
export const CARD_MOVES = ["h", "j", "k", "l", "g", "G", "ArrowLeft", "ArrowDown", "ArrowUp", "ArrowRight"];
export const RESERVED = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "z", "Ctrl+p", "Ctrl+h", "Ctrl+j", "Ctrl+k", "Ctrl+l", "Ctrl+b"];

export const ICONS = ["django", "python", "android", "node", "tauri", "rust", "go", "nvim", "folder"];
const FIELD_TYPES = ["text", "number", "bool", "choice", "list", "folder", "file", "folders", "files", "json", "secret"];

// ------------------------------------------------------------ the keys each table may have
const CONDITIONS = ["files", "all_files", "not_files", "json", "contains", "any", "git_remote", "path"];
const TABLES = {
  top: ["id", "name", "version", "api", "description", "homepage", "icon", "detect", "vars", "action", "generate", "tab", "panel", "card", "page", "view", "settings", "backend", "keys"],
  detect: [...CONDITIONS, "icon", "priority", "requires"],
  conditions: CONDITIONS,
  json: ["file", "key", "value"],
  contains: ["file", "text"],
  action: ["name", "command", "description", "confirm", "when", "tmux"],
  generate: ["source", "skip", "watch", "action"],
  source: ["json", "keys", "values", "file", "regex", "command", "split"],
  tab: ["id", "name", "description", "page", "setup", "setup_page"],
  panel: ["id", "name", "page", "scope", "height"],
  card: ["id", "name", "page", "height", "opens"],
  page: ["id", "page"],
  view: ["name", "page", "status"],
  field: ["key", "label", "type", "default", "help", "multiline", "min", "max", "choices"],
  backend: ["command", "install", "actions", "watch", "autostart"],
  keymap: ["name", "surface", "bindings"],
  binding: ["keys", "action", "does"],
};
const REQUIRED = {
  top: ["id", "name", "version", "api"], json: ["file", "key"], contains: ["file", "text"], action: ["name", "command"],
  generate: ["source", "action"], tab: ["id", "name", "page"], panel: ["id", "name", "page"], card: ["id", "name", "page"], page: ["id", "page"],
  view: ["name", "page"], field: ["key", "label", "type"], backend: ["command"], keymap: ["name", "surface", "bindings"],
  binding: ["keys", "action", "does"],
};

/** How many letters to change, add or remove to turn one word into the other */
function distance(a, b) {
  let row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 0; i < a.length; i++) {
    const next = [i + 1];
    for (let j = 0; j < b.length; j++) next.push(Math.min(row[j] + (a[i] === b[j] ? 0 : 1), row[j + 1] + 1, next[j] + 1));
    row = next;
  }
  return row[b.length];
}

/** Unknown and missing keys of a table, in words */
function shape(value, kind, where, out) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    out.push(`${where} should be a table`);
    return false;
  }
  for (const key of Object.keys(value)) {
    if (TABLES[kind].includes(key)) continue;
    const close = TABLES[kind].map((k) => [distance(key, k), k]).filter(([d]) => d <= 2).sort((a, b) => a[0] - b[0])[0];
    out.push(close ? `${where}: there's no key ${key} (did you mean ${close[1]}?)` : `${where}: there's no key ${key} here (the keys are ${TABLES[kind].join(", ")})`);
  }
  for (const key of REQUIRED[kind] ?? []) if (!(key in value)) out.push(`${where}: it needs ${key}`);
  return true;
}

const list = (v) => (Array.isArray(v) ? v : v === undefined ? [] : [v]);
const isId = (s) => typeof s === "string" && /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(s);
const isVersion = (s) => typeof s === "string" && /^\d+\.\d+\.\d+(-.*)?$/.test(s);

/** A file the manifest names: relative, inside the plugin folder, and there */
function checkFile(folder, path, what, out) {
  if (typeof path !== "string") return out.push(`${what} should be a file name`);
  if (isAbsolute(path) || normalize(path).split(/[\\/]/).includes("..")) return out.push(`${what} (${path}) must be inside the plugin's folder`);
  let ok = false;
  try {
    ok = statSync(join(folder, path)).isFile();
  } catch {}
  if (!ok) out.push(`${what} (${path}) isn't there`);
}

function checkRegex(re, what, out, groups = 0) {
  try {
    const r = new RegExp(String(re).replace(/\(\?P</g, "(?<"));
    if (groups && new RegExp(`${r.source}|`).exec("").length - 1 < groups) out.push(`${what} needs a (group)`);
  } catch (e) {
    out.push(`${what}: ${e.message}`);
  }
}

function checkConditions(c, where, out) {
  if (!shape(c, "conditions", where, out)) return;
  for (const [i, j] of list(c.json).entries()) shape(j, "json", `${where}.json[${i}]`, out);
  for (const [i, t] of list(c.contains).entries()) shape(t, "contains", `${where}.contains[${i}]`, out);
  for (const [i, a] of list(c.any).entries()) checkConditions(a, `${where}.any[${i}]`, out);
  if (c.git_remote !== undefined) checkRegex(c.git_remote, `${where}: git_remote isn't a valid regular expression`, out);
}

function fits(f, v) {
  switch (f.type) {
    case "number": return typeof v === "number";
    case "bool": return typeof v === "boolean";
    case "list": case "folders": case "files": return Array.isArray(v) && v.every((x) => typeof x === "string");
    case "choice": return typeof v === "string" && list(f.choices).some((c) => (typeof c === "string" ? c : c?.value) === v);
    case "json": return true;
    default: return typeof v === "string";
  }
}

function checkFields(fields, place, reserved, out) {
  const seen = [];
  for (const [i, f] of list(fields).entries()) {
    if (!shape(f, "field", `${place}[${i}]`, out)) continue;
    const name = f.key || "a field";
    if (!f.key) out.push(`${place}: a field has no key`);
    else if (seen.includes(f.key)) out.push(`${place}: two fields are called ${f.key}`);
    else if (reserved.includes(f.key)) out.push(`${place}: ${f.key} is thumbdeck's own field; call it something else`);
    seen.push(f.key);
    if (!FIELD_TYPES.includes(f.type)) {
      out.push(`${place}: ${name} has type "${f.type}"; the types are ${FIELD_TYPES.join(", ")}`);
      continue;
    }
    if (f.type === "choice" && !list(f.choices).length) out.push(`${place}: ${name} is a choice but has no choices`);
    if (f.default !== undefined && !fits(f, f.default)) out.push(`${place}: ${name}'s default doesn't fit its type (${f.type})`);
  }
}

/** What's wrong with one keymap's keys */
export function keymapProblems(map, name) {
  const out = [];
  if (!String(map.name ?? "").trim()) out.push(`keys.${name} needs a name (shown in the status line)`);
  const seen = [];
  for (const b of list(map.bindings)) {
    const keys = list(b.keys);
    if (!String(b.action ?? "").trim()) out.push(`keys.${name}: a binding for ${keys.join(", ")} has no action`);
    if (!keys.length) out.push(`keys.${name}: the binding for ${b.action} has no keys`);
    for (const k of keys) {
      if (seen.includes(k)) out.push(`keys.${name}: ${k} is bound twice`);
      seen.push(k);
      if (RESERVED.includes(k)) out.push(`keys.${name}: ${k} is thumbdeck's (1–9 show tabs, z is wide, Ctrl+p the Plugins pane, Ctrl+h/j/k/l move between panes, Ctrl+b then n / p the next / previous tab)`);
      if (RULES[k] && RULES[k] !== b.action) out.push(`keys.${name}: ${k} runs ${b.action} here, but ${k} means ${RULES[k]} everywhere`);
    }
  }
  return out;
}

/** Check a plugin.toml's text (files it names are looked for in `folder`) */
export function checkManifest(text, folder) {
  let m;
  try {
    m = parse(text);
  } catch (e) {
    return [e instanceof TomlError ? `plugin.toml line ${e.line}: ${e.message.split("\n")[0]}` : `plugin.toml: ${e.message}`];
  }
  const out = [];
  if (!shape(m, "top", "plugin.toml", out)) return out;
  if ("id" in m && !isId(m.id)) out.push(`id "${m.id}" should be lowercase letters, digits and dashes (like "my-plugin")`);
  if ("name" in m && !String(m.name).trim()) out.push("name is empty");
  if ("version" in m && !isVersion(m.version)) out.push(`version "${m.version}" should look like 1.2.0`);
  if ("api" in m) {
    if (m.api > API[1]) out.push(`it's made for plugin API ${m.api}, and thumbdeck speaks up to ${API[1]}: update thumbdeck`);
    else if (!(Number.isInteger(m.api) && m.api >= API[0])) out.push(`api ${m.api} isn't a plugin API version (the first one is 1)`);
  }
  if (m.icon !== undefined) checkFile(folder, m.icon, "icon", out);

  if (m.detect !== undefined && shape(m.detect, "detect", "detect", out)) {
    const { icon, priority, requires, ...conditions } = m.detect;
    if (icon !== undefined) {
      if (String(icon).endsWith(".svg")) checkFile(folder, icon, "detect.icon", out);
      else if (!ICONS.includes(icon)) out.push(`detect.icon "${icon}" is neither an .svg file nor one of ${ICONS.join(", ")}`);
    }
    if (priority !== undefined && !Number.isInteger(priority)) out.push("detect.priority should be a whole number");
    if (requires !== undefined && !(Array.isArray(requires) && requires.every((r) => typeof r === "string"))) out.push("detect.requires should be a list of plugin ids");
    checkConditions(conditions, "detect", out);
  }

  const names = [];
  for (const [i, a] of list(m.action).entries()) {
    if (!shape(a, "action", `action[${i}]`, out)) continue;
    if (!String(a.name ?? "").trim()) out.push("an [[action]] has no name");
    else if (names.includes(a.name)) out.push(`two actions are called ${a.name}`);
    names.push(a.name);
    if ("command" in a && !String(a.command).trim()) out.push(`action ${a.name} has no command`);
    if (a.when !== undefined) checkConditions(a.when, `action ${a.name}: when`, out);
  }
  for (const [i, g] of list(m.generate).entries()) {
    if (!shape(g, "generate", `generate[${i}]`, out)) continue;
    const s = g.source ?? {};
    if (!shape(s, "source", `generate[${i}].source`, out)) continue;
    if ([s.json, s.file, s.command].filter((x) => x !== undefined).length !== 1) out.push("a [[generate]] source needs exactly one of json, file or command");
    if (s.json !== undefined && (s.keys !== undefined) === (s.values !== undefined)) out.push("a json source needs either keys or values");
    if (s.file !== undefined) {
      if (s.regex === undefined) out.push("a file source needs a regex");
      else checkRegex(s.regex, "bad regex", out);
    }
    if (g.action !== undefined) shape(g.action, "action", `generate[${i}].action`, out);
  }

  const ids = (kind, items) => {
    const seen = [];
    for (const x of items) {
      if (!isId(x.id)) out.push(`${kind} id "${x.id}" should be lowercase letters, digits and dashes`);
      else if (seen.includes(x.id)) out.push(`two ${kind}s have the id ${x.id}`);
      seen.push(x.id);
      if (x.page !== undefined) checkFile(folder, x.page, `${kind} ${x.id}'s page`, out);
    }
  };
  const tabs = list(m.tab).filter((t, i) => shape(t, "tab", `tab[${i}]`, out));
  const panels = list(m.panel).filter((p, i) => shape(p, "panel", `panel[${i}]`, out));
  const cards = list(m.card).filter((c, i) => shape(c, "card", `card[${i}]`, out));
  const pages = list(m.page).filter((p, i) => shape(p, "page", `page[${i}]`, out));
  ids("tab", tabs);
  ids("panel", panels);
  ids("card", cards);
  ids("page", pages);
  for (const t of tabs) {
    if (!String(t.name ?? "").trim()) out.push(`tab ${t.id} has no name`);
    checkFields(t.setup, `tab ${t.id}'s setup`, ["title"], out);
    if (t.setup_page !== undefined) checkFile(folder, t.setup_page, `tab ${t.id}'s setup_page`, out);
  }
  for (const p of panels) {
    if (p.scope !== undefined && p.scope !== "project" && p.scope !== "app") out.push(`panel ${p.id}: scope is "project" or "app", not "${p.scope}"`);
    if (p.height !== undefined && !(Number.isInteger(p.height) && p.height >= 0) && p.height !== "auto") out.push(`panel ${p.id}: height is "auto" or a number of lines`);
  }
  for (const c of cards) {
    if (c.height !== undefined && !(Number.isInteger(c.height) && c.height >= 0) && c.height !== "auto") out.push(`card ${c.id}: height is "auto" or a number of lines`);
    if (c.opens !== undefined && !tabs.some((t) => t.id === c.opens)) out.push(`card ${c.id}: opens "${c.opens}", which isn't one of the plugin's tabs`);
  }
  if (m.view !== undefined && shape(m.view, "view", "view", out) && m.view.page !== undefined) checkFile(folder, m.view.page, "the view's page", out);
  checkFields(m.settings, "settings", [], out);
  if (m.backend !== undefined && shape(m.backend, "backend", "backend", out) && "command" in m.backend && !String(m.backend.command).trim()) out.push("backend.command is empty");

  for (const [name, map] of Object.entries(m.keys ?? {})) {
    if (!shape(map, "keymap", `keys.${name}`, out)) continue;
    for (const [i, b] of list(map.bindings).entries()) shape(b, "binding", `keys.${name}.bindings[${i}]`, out);
    out.push(...keymapProblems(map, name));
    const [kind, id] = String(map.surface ?? "").split(":");
    const exists = id === undefined
      ? map.surface === "view" && m.view !== undefined
      : ({ tab: tabs, panel: panels, card: cards, page: pages }[kind] ?? []).some((x) => x.id === id);
    if (!exists) out.push(`keys.${name}: surface "${map.surface}" isn't one of the plugin's (tab:<id>, panel:<id>, card:<id>, page:<id> or view)`);
    if (kind === "card") {
      for (const k of list(map.bindings).flatMap((b) => list(b.keys)).filter((k) => CARD_MOVES.includes(k))) {
        out.push(`keys.${name}: on a card, ${k} is thumbdeck's (it moves between the Overview's cards)`);
      }
    }
  }
  return out;
}

/** Check a plugin folder: { name, version, id, problems } */
export function checkFolder(folder) {
  const file = join(folder, "plugin.toml");
  if (!existsSync(file)) return { problems: [`there's no plugin.toml in ${folder}`] };
  const text = readFileSync(file, "utf8");
  const problems = checkManifest(text, folder);
  let info = {};
  try {
    const m = parse(text);
    info = { id: m.id, name: m.name, version: m.version };
  } catch {}
  return { ...info, problems };
}
