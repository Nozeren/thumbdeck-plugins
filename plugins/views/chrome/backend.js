// The Chrome backend: reads the browser's profiles (its "Local State"), keeps your labels,
// tenants, shortcuts and link rules (state.json in the plugin's data folder), starts a profile's
// window, makes and deletes profiles, and opens thumbdeck's links in the profile a rule picks.
// Chrome's files are only written when you delete a profile, and only while Chrome isn't running.
import { execFile, spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readlinkSync, renameSync, rmSync, watch, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
// In your own plugin: `npm install @thumbdeck/backend`. The official plugins use the copy in
// this repository.
import { serve } from "../../../packages/backend/index.js";
import { BROWSERS, arrange, nextProfileDir, parseShortcuts, readLocalState, ruleFor, tenantId, withoutProfile } from "./chrome.js";

const mac = process.platform === "darwin";
let settings = { browser: "chrome", route_links: true };
let state = { tenants: [], profiles: {}, rules: [] };
let file = null;
let dataFolder = null;
let tb = null;

const browser = () => BROWSERS[settings.browser] ?? BROWSERS.chrome;
const userData = () => join(homedir(), (mac ? browser().mac : browser().linux)[0]);
const localStatePath = () => join(userData(), "Local State");

function save() {
  writeFileSync(file, JSON.stringify(state, null, 1), { mode: 0o600 });
  tb.event("changed");
}

function readChrome() {
  try {
    return { profiles: readLocalState(JSON.parse(readFileSync(localStatePath(), "utf8"))), found: true };
  } catch (e) {
    return { profiles: [], found: false, problem: e.code === "ENOENT" ? `${browser().name} isn't set up here: no ${localStatePath()}` : `Couldn't read ${browser().name}'s profiles: ${e.message}` };
  }
}

/** Is the browser running? Its SingletonLock points at host-pid while it is */
function running() {
  try {
    const [host, pid] = readlinkSync(join(userData(), "SingletonLock")).split(/-(?=\d+$)/);
    if (host !== hostname()) return true; // another machine's lock: say yes, to be safe
    process.kill(+pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
}

function view() {
  const chrome = readChrome();
  const live = running();
  const { tenants, profiles } = arrange(chrome.profiles, state);
  for (const p of profiles) {
    p.open = live && p.active;
    if (p.dir === state.opened?.dir) p.used = Math.max(p.used, state.opened.at); // before the browser notes it
  }
  return { browser: browser().name, found: chrome.found, problem: chrome.problem ?? "", running: live, tenants, profiles, rules: state.rules };
}

function status(v = view()) {
  const last = v.profiles.filter((p) => !p.hidden).sort((a, b) => b.used - a.used)[0];
  const t = last && v.tenants.find((t) => t.id === last.tenant);
  tb.status(last ? (t && t.id !== "none" && t.name !== last.name ? `${t.name} · ${last.role || last.name}` : last.name) : null);
}

/** The program that starts the browser (Linux: the first one on PATH) */
function program() {
  if (mac) return null;
  const dirs = (process.env.PATH ?? "").split(":");
  for (const name of browser().linux[1]) for (const d of dirs) if (d && existsSync(join(d, name))) return join(d, name);
  throw new Error(`${browser().linux[1][0]} isn't installed (or not on PATH)`);
}

/** Start (or bring forward) a profile's window, at a page when given one */
function launch(dir, url) {
  const args = [`--profile-directory=${dir}`, ...(url ? [url] : [])];
  const [cmd, argv] = mac ? ["open", ["-na", browser().mac[1], "--args", ...args]] : [program(), args];
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, argv, { detached: true, stdio: "ignore" });
    p.on("error", (e) => reject(new Error(`couldn't start ${browser().name}: ${e.message}`)));
    p.on("spawn", () => {
      p.unref();
      state.opened = { dir, at: Date.now() };
      writeFileSync(file, JSON.stringify(state, null, 1), { mode: 0o600 });
      resolve();
    });
  });
}

function meta(dir) {
  return (state.profiles[dir] ??= {});
}

/** A tenant picked in the form: an id, "auto", "none", or a new one ({ name, domains }) */
function pickTenant(choice, fresh) {
  if (choice === "new") {
    const name = String(fresh?.name || "").trim() || "New tenant";
    const id = tenantId(name, state.tenants.map((t) => t.id));
    state.tenants.push({ id, name, domains: splitDomains(fresh?.domains) });
    return id;
  }
  if (choice?.startsWith("@") || choice === "personal") return adopt(choice);
  return choice === "auto" ? undefined : choice;
}

const splitDomains = (s) => String(s ?? "").split(/[\s,]+/).map((d) => d.replace(/^@/, "").toLowerCase()).filter(Boolean);

/** A tenant thumbdeck made up from a domain becomes one of yours (to rename it, pick it) */
function adopt(id) {
  if (state.tenants.some((t) => t.id === id)) return id;
  const made = view().tenants.find((t) => t.id === id);
  if (!made) return id;
  const real = { id: tenantId(made.name, state.tenants.map((t) => t.id)), name: made.name, domains: made.domains };
  state.tenants.push(real);
  return real.id;
}

function profileFrom(p, m) {
  if (p.label !== undefined) m.label = String(p.label).trim() || undefined;
  if (p.account !== undefined) m.account = String(p.account).trim() || undefined;
  if (p.role !== undefined) m.role = String(p.role).trim() || undefined;
  if (p.color !== undefined) m.color = p.color || undefined;
  if (p.shortcuts !== undefined) m.shortcuts = parseShortcuts(p.shortcuts);
  if (p.tenant !== undefined) m.tenant = pickTenant(p.tenant, p.newTenant);
}

function trash(path) {
  if (mac) return renameSync(path, join(homedir(), ".Trash", `${path.split("/").pop()} ${Date.now()}`));
  return new Promise((resolve) =>
    execFile("gio", ["trash", path], (err) => {
      if (err) rmSync(path, { recursive: true, force: true }); // no gio: gone for good
      resolve(!err);
    }),
  );
}

async function claim() {
  try {
    await tb.request("links.claim", { on: !!settings.route_links });
  } catch {} // an older thumbdeck: its links open in the default browser
}

serve({
  initialize(info, t) {
    tb = t;
    settings = { ...settings, ...info.settings };
    dataFolder = info.dataFolder;
    mkdirSync(dataFolder, { recursive: true });
    file = join(dataFolder, "state.json");
    try {
      state = { ...state, ...JSON.parse(readFileSync(file, "utf8")) };
    } catch {}
    claim();
    status();
    // Chrome rewrites Local State (with a rename) as profiles are used, added or removed
    let timer = null;
    try {
      watch(userData(), (_, name) => {
        if (name !== "Local State" && name !== "SingletonLock") return;
        clearTimeout(timer);
        timer = setTimeout(() => (tb.event("changed"), status()), 400);
      });
    } catch {}
  },
  settings(s) {
    settings = { ...settings, ...s };
    claim();
    tb.event("changed");
  },
  list: () => view(),

  async open({ dir, url }) {
    await launch(dir, url);
    status();
  },

  async create(p) {
    const dirs = [...readChrome().profiles.map((x) => x.dir), ...Object.keys(state.profiles)];
    let dir = nextProfileDir(dirs);
    while (existsSync(join(userData(), dir))) dir = nextProfileDir([...dirs, dir]);
    const m = meta(dir);
    profileFrom(p, m);
    m.created = Date.now();
    save();
    await launch(dir); // a folder Chrome doesn't know yet: it makes the profile
    return dir;
  },

  edit(p) {
    profileFrom(p, meta(p.dir));
    save();
  },

  move({ dir, tenant }) {
    meta(dir).tenant = pickTenant(tenant);
    save();
  },

  hide({ dir, hidden }) {
    meta(dir).hidden = hidden || undefined;
    save();
  },

  /** Delete the profile from the browser: its entry in Local State (backed up first) and its folder (to the Trash) */
  async remove({ dir }) {
    if (dir === "Default") throw new Error(`${browser().name}'s first profile can't be deleted here`);
    if (running()) throw new Error(`Quit ${browser().name} first (every window): it rewrites its profile list when it quits`);
    const path = localStatePath();
    const before = JSON.parse(readFileSync(path, "utf8"));
    mkdirSync(join(dataFolder, "backups"), { recursive: true });
    cpSync(path, join(dataFolder, "backups", `Local State ${new Date().toISOString().replace(/[:.]/g, "-")}`));
    writeFileSync(path, JSON.stringify(withoutProfile(before, dir)));
    const folder = join(userData(), dir);
    const trashed = existsSync(folder) ? await trash(folder) : true;
    delete state.profiles[dir];
    state.rules = state.rules.filter((r) => r.dir !== dir);
    save();
    return { trashed };
  },

  saveTenant({ id, name, domains }) {
    name = String(name ?? "").trim();
    if (!name) throw new Error("A tenant needs a name");
    const t = id && state.tenants.find((t) => t.id === adopt(id));
    if (t) Object.assign(t, { name, domains: splitDomains(domains) });
    else state.tenants.push({ id: tenantId(name, state.tenants.map((t) => t.id)), name, domains: splitDomains(domains) });
    save();
  },

  /** Its profiles move to Ungrouped (they stay in the browser) */
  removeTenant({ id }) {
    for (const p of view().profiles) if (p.tenant === id) meta(p.dir).tenant = "none";
    state.tenants = state.tenants.filter((t) => t.id !== id);
    save();
  },

  saveRule({ index, pattern, dir }) {
    pattern = String(pattern ?? "").trim();
    if (!pattern) throw new Error("A rule needs a pattern");
    if (index == null) state.rules.push({ pattern, dir });
    else state.rules[index] = { pattern, dir };
    save();
  },
  removeRule({ index }) {
    state.rules.splice(index, 1);
    save();
  },
  moveRule({ index, by }) {
    const to = index + by;
    if (to < 0 || to >= state.rules.length) return index;
    [state.rules[index], state.rules[to]] = [state.rules[to], state.rules[index]];
    save();
    return to;
  },
  match: ({ url }) => ruleFor(state.rules, url),

  /** thumbdeck's links (links.claim): true when a rule's profile opened it */
  async openUrl({ url }) {
    if (!settings.route_links || !/^https?:/.test(url)) return false;
    const rule = ruleFor(state.rules, url);
    if (!rule) return false;
    await launch(rule.dir, url);
    return true;
  },
});
