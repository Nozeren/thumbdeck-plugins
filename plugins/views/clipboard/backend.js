// The Clipboard backend: notices every copy (wl-paste --watch on Wayland; a look every second
// with pbpaste on macOS or xclip / xsel on X11), keeps the list, and copies an item back.
// Copies a password manager marks as secret aren't kept.
import { spawn, execFile } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
// In your own plugin: `npm install @thumbdeck/backend`. The official plugins use the copy in
// this repository.
import { serve } from "../../../packages/backend/index.js";
import { add, isSecret } from "./clip.js";

let settings = { keep: 100, remember: true };
let items = [];
let paused = false;
let problem = "";
let tb = null;
let file = null; // the history, in the plugin's data folder; readable only by you

function save() {
  if (!settings.remember) return;
  try {
    writeFileSync(file, JSON.stringify(items), { mode: 0o600 });
    chmodSync(file, 0o600);
  } catch {}
}

// The tools for this system: read the text, list the types (null: can't), write, watch
const wayland = !!process.env.WAYLAND_DISPLAY;
const mac = process.platform === "darwin";
const TOOLS = wayland
  ? { read: ["wl-paste", "--no-newline", "--type", "text"], types: ["wl-paste", "--list-types"], write: ["wl-copy"], watch: ["wl-paste", "--watch", "echo", "changed"] }
  : mac
    ? { read: ["pbpaste"], types: null, write: ["pbcopy"], watch: null }
    : { read: ["xclip", "-selection", "clipboard", "-o"], types: ["xclip", "-selection", "clipboard", "-t", "TARGETS", "-o"], write: ["xclip", "-selection", "clipboard"], watch: null };

const run = (cmd) =>
  new Promise((resolve) => execFile(cmd[0], cmd.slice(1), { maxBuffer: 4_000_000, timeout: 5000 }, (err, stdout) => resolve(err ? null : stdout)));

let last = null;
async function look() {
  if (paused) return;
  if (TOOLS.types) {
    const types = await run(TOOLS.types);
    if (types === null) return; // empty clipboard, or an image only
    if (isSecret(types.split("\n"))) return;
    if (!types.split("\n").some((t) => /^(text\/plain|UTF8_STRING|STRING|TEXT)/.test(t.trim()))) return;
  }
  const text = await run(TOOLS.read);
  if (text === null || text === last) return;
  last = text;
  const before = items;
  items = add(items, text, Date.now(), settings.keep);
  if (items !== before) changed();
}

function changed() {
  save();
  tb.status(paused ? "paused" : null);
  tb.event("changed");
}

function watch() {
  if (TOOLS.watch) {
    const p = spawn(TOOLS.watch[0], TOOLS.watch.slice(1), { stdio: ["ignore", "pipe", "ignore"] });
    p.on("error", () => (problem = `${TOOLS.watch[0]} isn't installed (wl-clipboard has it)`));
    createInterface({ input: p.stdout }).on("line", look);
    p.on("exit", () => setTimeout(watch, 3000)); // it ends when the compositor restarts
  } else {
    setInterval(look, 1000);
    run(TOOLS.read).then((t) => {
      if (t === null && !mac) problem = "Install xclip to keep a clipboard history";
    });
  }
}

function copy(text) {
  return new Promise((resolve, reject) => {
    const p = spawn(TOOLS.write[0], TOOLS.write.slice(1), { stdio: ["pipe", "ignore", "ignore"], detached: TOOLS.write[0] !== "pbcopy" });
    p.on("error", () => reject(new Error(`${TOOLS.write[0]} isn't installed`)));
    p.on("spawn", () => {
      p.stdin.end(text);
      p.unref(); // wl-copy and xclip stay to serve the paste
      resolve();
    });
  });
}

const find = (id) => items.find((i) => i.id === id) ?? (() => { throw new Error("it's no longer in the list"); })();

serve({
  initialize(info, t) {
    tb = t;
    settings = { ...settings, ...info.settings };
    mkdirSync(info.dataFolder, { recursive: true });
    file = `${info.dataFolder}/history.json`;
    if (settings.remember) {
      try {
        items = JSON.parse(readFileSync(file, "utf8"));
      } catch {}
    }
    watch();
  },
  settings(s) {
    settings = { ...settings, ...s };
    if (!settings.remember) rmSync(file, { force: true });
    changed();
  },
  list: () => ({ items, paused, problem }),
  async copy({ id }) {
    const it = find(id);
    await copy(it.text);
    last = it.text;
    items = add(items, it.text, Date.now(), settings.keep);
    changed();
  },
  pin({ id }) {
    const it = find(id);
    it.pinned = !it.pinned;
    changed();
    return it.pinned;
  },
  remove({ id }) {
    items = items.filter((i) => i.id !== id);
    changed();
  },
  clear() {
    items = items.filter((i) => i.pinned);
    changed();
  },
  pause() {
    paused = !paused;
    changed();
    return paused;
  },
});
