// The Env tab: the project's .env against its example, key by key. Values are hidden (m shows
// one); nothing is written unless you ask (a: add the missing keys).
import { compare, EXAMPLES, mask, missingLines, parse } from "./env.js";

const td = window.thumbdeck;
const esc = td.escape;
const $ = (id) => document.getElementById(id);
const LABEL = {
  missing: ["red", "missing"], empty: ["yellow", "empty"], example: ["yellow", "example's"],
  extra: ["blue", "not in example"], ok: ["green", "ok"],
};

let setup = { env_file: ".env", example_file: "" };
let files = { env: ".env", example: null };
let rows = [];
let cursor = 0;
let error = "";
const shownKeys = new Set();
let unwatch = [];

async function read(path) {
  return (await td.fs.stat(path)) ? td.fs.read(path) : null;
}

async function load() {
  setup = await td.setup.get();
  files.env = setup.env_file || ".env";
  files.example = setup.example_file || null;
  if (!files.example) {
    for (const f of EXAMPLES) if (await td.fs.stat(f)) { files.example = f; break; }
  }
  try {
    const example = files.example ? await read(files.example) : null;
    if (example === null) throw new Error(`There's no ${files.example ?? "example file"} to compare with: set one in the tab's setup (S)`);
    const env = await read(files.env);
    rows = compare(parse(example), env === null ? [] : parse(env));
    error = env === null ? `There's no ${files.env} yet: a (add the missing keys) makes one from ${files.example}` : "";
  } catch (e) {
    rows = [];
    error = e.message;
  }
  cursor = Math.min(cursor, Math.max(0, rows.length - 1));
  watch();
  render();
}

function watch() {
  for (const stop of unwatch) stop();
  unwatch = [files.env, files.example].filter(Boolean).map((f) => td.fs.watch(f, () => load()));
}

function render() {
  const count = (s) => rows.filter((r) => r.status === s).length;
  const problems = count("missing") + count("empty") + count("example");
  td.ui.badge(problems || null);
  $("files").textContent = `${files.env} ↔ ${files.example ?? "?"}`;
  $("summary").innerHTML = rows.length
    ? ["missing", "empty", "example", "extra"].filter(count).map((s) => `<span class="td-badge ${LABEL[s][0]}">${count(s)} ${LABEL[s][1]}</span>`).join(" ")
      || `<span class="td-badge green">all ${rows.length} ok</span>`
    : "";
  $("error").hidden = !error;
  $("error").textContent = error;
  $("table").innerHTML = rows.length
    ? `<table><thead><tr><th>Key</th><th></th><th>Value</th></tr></thead><tbody>
      ${rows.map((r, n) => {
        const shown = shownKeys.has(r.key);
        const value = r.status === "missing" ? `example: ${mask(r.example)}` : shown ? r.value : mask(r.value);
        return `<tr class="${n === cursor ? "cursor" : ""}" data-n="${n}"><td class="key">${esc(r.key)}</td>
          <td><span class="td-badge ${LABEL[r.status][0]}">${LABEL[r.status][1]}</span></td>
          <td class="value${shown && r.status !== "missing" ? " shown" : ""}">${esc(value)}</td></tr>`;
      }).join("")}</tbody></table>
      <p class="hint">m shows a value · a adds the missing keys · l opens the file at the key</p>`
    : "";
  $("table").querySelector(".cursor")?.scrollIntoView({ block: "nearest" });
}

function move(to) {
  cursor = Math.max(0, Math.min(rows.length - 1, to));
  render();
}

async function open() {
  const r = rows[cursor];
  if (!r) return;
  const [file, line] = r.line ? [files.env, r.line] : [files.example, r.exampleLine];
  td.ui.say(await td.tmux(`nvim +${line} ${JSON.stringify(file)}`, { window: "env" }));
}

async function addMissing() {
  const lines = missingLines(rows);
  if (!lines.length) return td.ui.say("nothing is missing");
  const keys = rows.filter((r) => r.status === "missing").map((r) => r.key);
  if (!(await td.ui.confirm(`Add ${keys.length === 1 ? keys[0] : `${keys.length} keys`} to ${files.env}, with ${files.example}'s values?`, { yes: "Add" }))) return;
  const now = (await read(files.env)) ?? "";
  const sep = now === "" || now.endsWith("\n") ? "" : "\n";
  await td.fs.write(files.env, `${now}${sep}${lines.join("\n")}\n`);
  td.ui.say(`added ${keys.join(", ")} to ${files.env}`);
  load();
}

td.on("key", ({ action }) => {
  const r = rows[cursor];
  switch (action) {
    case "down": return move(cursor + 1);
    case "up": return move(cursor - 1);
    case "first": return move(0);
    case "last": return move(rows.length - 1);
    case "open": return open();
    case "show":
      if (!r) return;
      if (shownKeys.has(r.key)) shownKeys.delete(r.key);
      else shownKeys.add(r.key);
      return render();
    case "add": return addMissing();
    case "refresh": return load().then(() => td.ui.say("read them again"));
  }
});
// Values shown stay shown only while you look
td.on("hidden", () => {
  shownKeys.clear();
  render();
});
td.on("setup", load);
document.addEventListener("click", (e) => {
  const row = e.target.closest("[data-n]");
  if (row) move(Number(row.dataset.n));
});
load();
