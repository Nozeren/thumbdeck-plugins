// The Clipboard view: what you copied, newest first (pinned ones on top), the highlighted one
// in full beside it. The backend keeps the list (backend.js).
import { age, kind, line, shown } from "./clip.js";

const td = window.thumbdeck;
const esc = td.escape;
const $ = (id) => document.getElementById(id);

let data = { items: [], paused: false, problem: "" };
let cursor = 0;
let words = "";

const list = () => shown(data.items, words);

async function load() {
  data = await td.backend.call("list");
  cursor = Math.min(cursor, Math.max(0, list().length - 1));
  render();
}

function render() {
  const items = list();
  const now = Date.now();
  $("summary").textContent = [
    data.items.length ? `${data.items.length} kept` : "",
    words ? `${items.length} with "${words}"` : "",
    data.paused ? "paused (s resumes)" : "",
  ].filter(Boolean).join(" · ");
  $("error").hidden = !data.problem;
  $("error").textContent = data.problem;
  $("list").innerHTML = items.length
    ? items.map((i, n) => {
        const k = kind(i.text);
        return `<li class="item${n === cursor ? " cursor" : ""}" data-n="${n}"><span class="pin">${i.pinned ? "◆" : ""}</span>
          <span class="text">${esc(line(i.text))}</span>${k ? `<span class="kind td-badge">${esc(k)}</span>` : ""}
          <span class="age">${age(i.at, now)}</span></li>`;
      }).join("")
    : `<li class="empty">${words ? "Nothing matches." : "Copy something: it shows up here. y copies an item again, p pins it."}</li>`;
  $("list").querySelector(".cursor")?.scrollIntoView({ block: "nearest" });
  $("preview").textContent = items[cursor]?.text ?? "";
}

function move(to) {
  cursor = Math.max(0, Math.min(list().length - 1, to));
  render();
}

async function act(method, it, done) {
  try {
    const r = await td.backend.call(method, it ? { id: it.id } : null);
    if (done) td.ui.say(done(r));
  } catch (e) {
    td.ui.say(e.message, { error: true });
  }
  load();
}

function startFilter() {
  const f = $("filter");
  f.hidden = false;
  f.value = words;
  f.focus();
}
$("filter").addEventListener("input", () => {
  words = $("filter").value.trim();
  cursor = 0;
  render();
});
$("filter").addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    $("filter").blur();
    if (!words) $("filter").hidden = true;
  } else if (e.key === "Escape") {
    words = "";
    $("filter").hidden = true;
    cursor = 0;
    render();
  }
});

td.on("key", async ({ action }) => {
  const it = list()[cursor];
  switch (action) {
    case "down": return move(cursor + 1);
    case "up": return move(cursor - 1);
    case "first": return move(0);
    case "last": return move(list().length - 1);
    case "filter": return startFilter();
    case "copy":
      if (!it) return;
      cursor = 0;
      return act("copy", it, () => `copied: ${line(it.text, 40)}`);
    case "pin": return it && act("pin", it, (pinned) => (pinned ? "pinned" : "unpinned"));
    case "remove": return it && act("remove", it, () => "removed");
    case "clear":
      if (!(await td.ui.confirm("Clear the clipboard history? Pinned ones stay.", { yes: "Clear" }))) return;
      return act("clear", null, () => "cleared");
    case "pause": return act("pause", null, (p) => (p ? "paused: copies aren't kept" : "keeping copies again"));
  }
});
td.backend.on("changed", load);
document.addEventListener("click", (e) => {
  const row = e.target.closest("[data-n]");
  if (row) move(Number(row.dataset.n));
});
document.addEventListener("dblclick", (e) => e.target.closest("[data-n]") && act("copy", list()[cursor]));
setInterval(render, 60_000); // the ages
load();
