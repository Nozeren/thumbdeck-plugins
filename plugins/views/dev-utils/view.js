// The Dev utils view: what's in the box, read every way it can be (utils.js); with the box
// empty, the time now and a UUID. Nothing leaves your computer.
import { analyze, idle, uuid } from "./utils.js";

const td = window.thumbdeck;
const esc = td.escape;
const input = document.getElementById("input");
const $results = document.getElementById("results");

let results = [];
let cursor = 0;
let id = uuid(); // the UUID shown, until n asks for another

function update() {
  results = input.value.trim() ? analyze(input.value) : idle(Date.now(), id);
  cursor = Math.min(cursor, Math.max(0, results.length - 1));
  render();
}

function render() {
  $results.innerHTML = results.map((r, n) => `<div class="result${n === cursor ? " cursor" : ""}" data-n="${n}">
    <div class="label">${esc(r.label)}</div><pre class="value">${esc(r.value)}</pre></div>`).join("");
  $results.querySelector(".cursor")?.scrollIntoView({ block: "nearest" });
}

function move(to) {
  cursor = Math.max(0, Math.min(results.length - 1, to));
  render();
}

async function copy() {
  const r = results[cursor];
  if (!r) return;
  try {
    await navigator.clipboard.writeText(r.value);
    td.ui.say(`copied ${r.label}`);
  } catch {
    td.ui.say("couldn't copy to the clipboard", { error: true });
  }
}

async function paste() {
  try {
    input.value = await navigator.clipboard.readText();
    cursor = 0;
    update();
  } catch {
    td.ui.say("couldn't read the clipboard: press i and paste with Ctrl+V", { error: true });
  }
}

td.on("key", ({ action }) => {
  switch (action) {
    case "type": return input.focus();
    case "paste": return paste();
    case "down": return move(cursor + 1);
    case "up": return move(cursor - 1);
    case "first": return move(0);
    case "last": return move(results.length - 1);
    case "copy": return copy();
    case "clear":
      input.value = "";
      cursor = 0;
      return update();
    case "uuid":
      id = uuid();
      if (!input.value.trim()) update();
      return;
  }
});
input.addEventListener("input", () => {
  cursor = 0;
  update();
});
$results.addEventListener("click", (e) => {
  const r = e.target.closest("[data-n]");
  if (r) move(Number(r.dataset.n));
});
$results.addEventListener("dblclick", copy);
// The time "now" moves on
setInterval(() => !input.value.trim() && document.activeElement !== input && update(), 1000);
update();
