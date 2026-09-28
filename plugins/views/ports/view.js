// The Ports view: what listens on which port (ss on Linux, lsof on macOS), the project each
// process runs in, and stopping one after asking. It looks again every 3 seconds.
import { KNOWN, parseCwd, parseLsof, parsePs, parseSs, ports, projectOf } from "./ports.js";

const td = window.thumbdeck;
const esc = td.escape;
const $ = (id) => document.getElementById(id);

let rows = [];
let cursor = 0;
let error = "";
let onlyMine = true;
let projects = [];
const url = (p) => `http://localhost:${p.port}`;

async function sockets() {
  const ss = await td.exec(["ss", "-Hltnp"]).catch(() => null);
  if (ss?.code === 0) return parseSs(ss.stdout);
  const lsof = await td.exec(["lsof", "-nP", "-iTCP", "-sTCP:LISTEN"]).catch(() => null);
  // lsof exits 1 when nothing listens
  if (lsof && (lsof.code === 0 || !lsof.stderr.trim())) return parseLsof(lsof.stdout);
  throw new Error("Neither ss nor lsof worked: install one (iproute2 has ss)");
}

async function load() {
  try {
    let found = ports(await sockets());
    if (onlyMine) found = found.filter((p) => p.procs.length);
    const pids = [...new Set(found.flatMap((p) => p.procs.map((x) => x.pid)))];
    if (pids.length) {
      const [ps, cwd] = await Promise.all([
        td.exec(["ps", "-o", "pid=,args=", "-p", pids.join(",")]),
        td.exec(["sh", "-c", 'if [ -d /proc/self ]; then for p; do printf "%s %s\\n" "$p" "$(readlink "/proc/$p/cwd" 2>/dev/null)"; done; else lsof -a -d cwd -Fpn -p "$(echo "$@" | tr " " ,)"; fi', "sh", ...pids.map(String)]),
      ]);
      const args = parsePs(ps.stdout);
      const dirs = parseCwd(cwd.stdout);
      for (const p of found) {
        const main = p.procs[0];
        p.command = main ? args.get(main.pid) ?? main.name : "";
        p.folder = main ? dirs.get(main.pid) ?? "" : "";
        p.project = projectOf(p.folder, projects);
      }
    }
    const was = rows[cursor]?.port;
    rows = found;
    const again = rows.findIndex((p) => p.port === was);
    cursor = again >= 0 ? again : Math.min(cursor, Math.max(0, rows.length - 1));
    error = "";
  } catch (e) {
    error = e.message;
  }
  render();
}

function render() {
  $("summary").textContent = rows.length ? `${rows.length} listening` : "";
  $("error").hidden = !error;
  $("error").textContent = error;
  if (!rows.length) {
    $("table").innerHTML = error ? "" : `<p class="empty">Nothing is listening${onlyMine ? " (of yours)" : ""}.</p>`;
    return;
  }
  $("table").innerHTML = `<table><thead><tr><th>Port</th><th>Address</th><th>Process</th><th>Project</th><th>Command</th></tr></thead><tbody>
    ${rows.map((p, n) => `<tr class="${n === cursor ? "cursor" : ""}" data-n="${n}" title="${esc([p.command, p.folder].filter(Boolean).join("\n"))}">
      <td class="port">${p.port}</td>
      <td>${esc(p.hosts.map((h) => (h === "*" ? "everywhere" : h)).join(", "))}${p.local ? "" : ` <span class="open" title="Other computers can reach it">●</span>`}</td>
      <td>${p.procs.length ? esc(`${p.procs[0].name} ${p.procs.map((x) => x.pid).join(" ")}`) : `<span class="known">${esc(KNOWN[p.port] ?? "someone else's")}</span>`}</td>
      <td class="project">${esc(p.project?.name ?? "")}</td>
      <td class="cmd">${KNOWN[p.port] && p.procs.length ? `<span class="known">${esc(KNOWN[p.port])} · </span>` : ""}${esc(p.command ?? "")}</td></tr>`).join("")}
    </tbody></table>`;
  $("table").querySelector(".cursor")?.scrollIntoView({ block: "nearest" });
}

function move(to) {
  cursor = Math.max(0, Math.min(rows.length - 1, to));
  render();
}

async function stop(p, force) {
  if (!p) return;
  if (!p.procs.length) return td.ui.say(`port ${p.port}: its process isn't yours, so it can't be stopped from here`, { error: true });
  const who = `${p.procs[0].name} (${p.procs.length > 1 ? `pids ${p.procs.map((x) => x.pid).join(", ")}` : `pid ${p.procs[0].pid}`})`;
  const question = force
    ? `Kill ${who} on port ${p.port}? It gets no chance to clean up.`
    : `Stop ${who} on port ${p.port}?`;
  if (!(await td.ui.confirm(question, { yes: force ? "Kill" : "Stop" }))) return;
  const r = await td.exec(["kill", ...(force ? ["-KILL"] : []), ...p.procs.map((x) => String(x.pid))]);
  if (r.code !== 0) return td.ui.say(r.stderr.trim() || `kill failed (${r.code})`, { error: true });
  td.ui.say(`${force ? "killed" : "stopped"} ${p.procs[0].name} on port ${p.port}`);
  setTimeout(load, 700);
}

async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
    td.ui.say(`copied ${text}`);
  } catch {
    td.ui.say("couldn't copy to the clipboard", { error: true });
  }
}

td.on("key", ({ action }) => {
  const p = rows[cursor];
  switch (action) {
    case "down": return move(cursor + 1);
    case "up": return move(cursor - 1);
    case "first": return move(0);
    case "last": return move(rows.length - 1);
    case "outside": return p && td.ui.openUrl(url(p));
    case "copy": return p && copy(url(p));
    case "stop": return stop(p, false);
    case "kill": return stop(p, true);
    case "refresh": return load();
  }
});
td.on("settings", (s) => {
  onlyMine = s.only_mine !== false;
  load();
});
document.addEventListener("click", (e) => {
  const row = e.target.closest("[data-n]");
  if (row) move(Number(row.dataset.n));
});

onlyMine = (await td.settings.get()).only_mine !== false;
projects = await td.projects.list();
await load();
// Looks again while it's shown
let shown = true;
td.on("shown", () => ((shown = true), load()));
td.on("hidden", () => (shown = false));
setInterval(() => shown && load(), 3000);
