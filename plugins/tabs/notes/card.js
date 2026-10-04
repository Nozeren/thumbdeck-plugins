// The Notes card in a project's Overview: the open checklist items (or the notes' first lines
// when there are none). Enter shows the Notes tab (plugin.toml's opens). Read-only; looks again
// every few seconds while shown, so it follows what you write in the tab.
import { openList } from "./notes.js";

const td = window.thumbdeck;
const esc = td.escape;
const MAX = 6;

async function draw() {
  const text = (await td.storage.get("text")) ?? "";
  const open = openList(text);
  td.ui.badge(open.length || null);
  let html;
  if (open.length) {
    html = open.slice(0, MAX).map((t) => `<div class="line"><span class="box">☐</span><span class="text">${esc(t || "…")}</span></div>`).join("");
    if (open.length > MAX) html += `<div class="line dim">and ${open.length - MAX} more</div>`;
  } else {
    const lines = text.split("\n").map((l) => l.trim()).filter(Boolean).slice(0, 3);
    html = lines.length
      ? lines.map((l) => `<div class="line"><span class="text dim">${esc(l)}</span></div>`).join("")
      : `<div class="line dim">No notes for this project yet.</div>`;
  }
  document.getElementById("card").innerHTML = html;
}

let shown = true;
td.on("shown", () => ((shown = true), draw()));
td.on("hidden", () => (shown = false));
setInterval(() => shown && !document.hidden && draw(), 3000);
draw();
