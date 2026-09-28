// The Notes tab: one text per project, saved as you write (in thumbdeck's storage for the
// plugin, not in the project). The tab's number is how many "- [ ]" items are open.
import { lineAt, openItems, toggle } from "./notes.js";

const td = window.thumbdeck;
const box = document.getElementById("text");
const saved = document.getElementById("saved");
let timer = null;
let caret = 0;

async function load() {
  box.value = (await td.storage.get("text")) ?? "";
  show();
}

function show() {
  td.ui.badge(openItems(box.value) || null);
}

async function save() {
  clearTimeout(timer);
  timer = null;
  await td.storage.set("text", box.value);
  saved.textContent = "saved";
  show();
}

box.addEventListener("input", () => {
  saved.textContent = "…";
  clearTimeout(timer);
  timer = setTimeout(save, 400);
});
box.addEventListener("blur", () => {
  caret = box.selectionStart;
  if (timer) save();
});

// Open in nvim: a file in the plugin's data folder, read back when it changes
async function outside() {
  if (timer) await save();
  const name = td.context.project.path.replace(/[^A-Za-z0-9]/g, "-");
  const file = `${td.context.plugin.dataFolder}/${name}.md`;
  await td.fs.write(file, box.value);
  td.fs.watch(file, async () => {
    const text = await td.fs.read(file);
    if (text !== box.value) {
      box.value = text;
      await save();
    }
  });
  td.ui.say(await td.tmux(`nvim ${JSON.stringify(file)}`, { window: "notes", show: true }));
}

td.on("key", ({ action }) => {
  if (action === "type") return box.focus();
  if (action === "outside") return outside();
  if (action === "tick") {
    let next = toggle(box.value, lineAt(box.value, caret));
    // Not on an item: the first open one
    if (next === box.value) {
      const first = box.value.split("\n").findIndex((l) => /^\s*[-*+] \[ \]/.test(l));
      if (first < 0) return td.ui.say("there's no open - [ ] item", { error: true });
      next = toggle(box.value, first);
    }
    box.value = next;
    box.setSelectionRange(caret, caret);
    save();
  }
});
load();
