// The Git tab: the project's repo at a glance, read-only. Three lists (Tab switches): the
// uncommitted changes, recent commits, and branches with stashes; the highlighted one's diff
// below. Keys come from thumbdeck as actions (plugin.toml [keys.git]).
import {
  ago, BRANCH_FORMAT, cut, groupChanges, lineKind, LOG_FORMAT, parseBranches, parseLog, parseStashes, parseStatus,
  refNames, STASH_FORMAT, stateWord, track,
} from "./git.js";

const td = window.thumbdeck;
const esc = td.escape;
const $ = (id) => document.getElementById(id);
const project = td.context.project;

/** Run git in the project; its output, or an error with git's message */
async function git(args, { exitOneIsFine = false } = {}) {
  const r = await td.exec(["git", "-c", "core.quotepath=off", "-c", "color.ui=never", "--no-pager", ...args], {
    env: { GIT_OPTIONAL_LOCKS: "0" },
  });
  // `git diff --no-index` exits 1 when the files differ
  if (r.code === 0 || (exitOneIsFine && r.code === 1)) return r.stdout;
  throw new Error((r.stderr.split("\n").find((l) => l.trim()) ?? "git failed").trim());
}

// ------------------------------------------------------------ reading the repo
async function status() {
  const s = parseStatus(await git(["status", "--porcelain=v1", "-b", "-z", "--untracked-files=all"]));
  let fetched = null;
  try {
    const dir = (await git(["rev-parse", "--git-dir"])).trim();
    fetched = (await td.fs.stat(`${dir}/FETCH_HEAD`))?.modified ?? null;
  } catch {}
  return { ...s, fetched };
}

async function diff(file, staged, untracked) {
  if (untracked) return cut(await git(["diff", "--no-index", "--", "/dev/null", file], { exitOneIsFine: true }));
  return cut(await git(staged ? ["diff", "--cached", "--", file] : ["diff", "--", file]));
}

/** Everything to review, as one diff: "changes" (all uncommitted changes, new files too), a
 *  commit (by hash), or a stash ("stash@{0}") */
async function review(what) {
  if (what === "changes") {
    // Against the last commit; a repo without commits has only the staged and unstaged diffs
    let out;
    try {
      out = await git(["diff", "HEAD", "--find-renames"]);
    } catch {
      out = (await git(["diff", "--cached"])) + (await git(["diff"]));
    }
    const untracked = (await git(["ls-files", "--others", "--exclude-standard", "-z"])).split("\0").filter(Boolean);
    for (const file of untracked) {
      out += await git(["diff", "--no-index", "--", "/dev/null", file], { exitOneIsFine: true });
      if (out.length > 300_000) break;
    }
    return cut(out);
  }
  if (what.startsWith("stash@{")) return cut(await git(["stash", "show", "--patch", "--find-renames", what]));
  return cut(await git(["show", "--format=", "--patch", "--find-renames", what]));
}

async function log(count) {
  try {
    return parseLog(await git(["log", `-n${Math.max(1, count)}`, LOG_FORMAT]));
  } catch (e) {
    if (/does not have any commits/.test(e.message)) return []; // a repo without commits yet
    throw e;
  }
}

async function branches() {
  const b = parseBranches(await git(["for-each-ref", "refs/heads", "--sort=-committerdate", BRANCH_FORMAT]));
  const stashes = parseStashes(await git(["stash", "list", STASH_FORMAT]));
  return { branches: b, stashes };
}

// ------------------------------------------------------------ the tab's state
const views = ["changes", "commits", "branches"];
const viewName = { changes: "Changes", commits: "Commits", branches: "Branches" };
const groupTitle = { staged: "Staged", changes: "Changes", untracked: "Untracked" };
let view = "changes";
let cursor = 0;
let error = "";
let st = null; // status
let commits = null;
let refs = null;
let setup = await td.setup.get();
let visible = true;

function rows() {
  if (view === "changes") return groupChanges(st?.changes ?? []).map((file) => ({ kind: "file", file }));
  if (view === "commits") return (commits ?? []).map((commit) => ({ kind: "commit", commit }));
  return [
    ...(refs?.branches ?? []).map((branch) => ({ kind: "branch", branch })),
    ...(refs?.stashes ?? []).map((stash) => ({ kind: "stash", stash })),
  ];
}

/** Which row that is: the same after a refresh rebuilds the list */
function rowKey(r) {
  if (!r) return "";
  if (r.kind === "file") return `${view}:${r.file.group}:${r.file.change.path}`;
  return `${view}:${r.kind === "commit" ? r.commit.hash : r.kind === "branch" ? r.branch.name : r.stash.name}`;
}

async function load(which = view) {
  try {
    if (which === "changes") st = await status();
    else if (which === "commits") commits = await log(setup.commits);
    else refs = await branches();
    error = "";
  } catch (e) {
    error = e.message;
  }
  cursor = Math.min(cursor, Math.max(0, rows().length - 1));
  render();
}

// ------------------------------------------------------------ drawing
function renderBar() {
  const b = st?.branch;
  let html = "";
  if (b) {
    html += `<strong class="branch">${esc(b.name ?? "detached HEAD")}</strong>`;
    if (b.upstream) {
      html += `<span class="dim">→ ${esc(b.upstream)}</span>`;
      html += b.gone ? `<span class="red">upstream gone</span>` : `<span class="track">${track(b.ahead, b.behind) || "up to date"}</span>`;
    } else if (b.name) html += `<span class="dim">no upstream</span>`;
    if (st.fetched) html += `<span class="dim">· fetched ${ago(new Date(st.fetched).toISOString())}</span>`;
  }
  html += `<span class="spacer"></span>`;
  const g = groupChanges(st?.changes ?? []);
  const staged = g.filter((r) => r.group === "staged").length;
  const changed = g.length - staged;
  for (const v of views) {
    const count = v === "changes" && st ? ` <span class="dim">${staged ? `${staged}+` : ""}${changed}</span>` : "";
    html += `<button class="seg${v === view ? " on" : ""}" data-view="${v}">${viewName[v]}${count}</button>`;
  }
  html += `<button class="tool" id="setup" title="Set up this tab (S)">⚙</button>`;
  $("bar").innerHTML = html;
}

function rowHtml(r, i) {
  const cls = `row${i === cursor ? " cursor" : ""}`;
  if (r.kind === "file") {
    const f = r.file;
    const s = f.state === "?" ? "N" : f.state;
    const from = f.change.from ? `<span class="dim"> ← ${esc(f.change.from)}</span>` : "";
    return `<li class="${cls}" data-i="${i}"><span class="state s${s}" title="${stateWord[f.state] ?? f.state}">${f.state === "?" ? "+" : f.state}</span>
      <span class="title">${esc(f.change.path)}${from}</span></li>`;
  }
  if (r.kind === "commit") {
    const c = r.commit;
    const tags = refNames(c.refs).map((n) => `<span class="ref">${esc(n)}</span>`).join("");
    return `<li class="${cls}" data-i="${i}"><span class="hash">${esc(c.short)}</span><span class="title">${esc(c.subject)}${tags}</span>
      <span class="meta">${esc(c.author)}</span><span class="meta">${ago(c.date)}</span></li>`;
  }
  if (r.kind === "branch") {
    const b = r.branch;
    return `<li class="${cls}" data-i="${i}"><span class="state">${b.current ? "●" : ""}</span>
      <span class="title${b.current ? " current" : ""}">${esc(b.name)} <span class="dim">${esc(b.subject)}</span></span>
      <span class="meta">${esc(b.track.replace(/[[\]]/g, ""))}</span><span class="meta">${ago(b.date)}</span></li>`;
  }
  const s = r.stash;
  return `<li class="${cls}" data-i="${i}"><span class="state dim">≡</span>
    <span class="title">${esc(s.name)} <span class="dim">${esc(s.subject)}</span></span><span class="meta">${ago(s.date)}</span></li>`;
}

function render() {
  renderBar();
  $("error").hidden = !error;
  $("error").textContent = error;
  const list = rows();
  let html = "";
  list.forEach((r, i) => {
    const prev = list[i - 1];
    if (r.kind === "file" && (prev?.kind !== "file" || prev.file.group !== r.file.group)) html += `<li class="group">${groupTitle[r.file.group]}</li>`;
    else if (r.kind === "stash" && prev?.kind !== "stash") html += `<li class="group">Stashes</li>`;
    html += rowHtml(r, i);
  });
  if (!list.length) {
    const looking = view === "changes" ? !st : view === "commits" ? !commits : !refs;
    const none = { changes: "Nothing to commit: the working tree is clean.", commits: "No commits yet.", branches: "No branches yet." }[view];
    html = `<li class="empty">${looking ? "Looking…" : none}</li>`;
  }
  $("rows").innerHTML = html;
  $("rows").querySelector(".cursor")?.scrollIntoView({ block: "nearest" });
  $("detail").hidden = !list[cursor];
  const key = rowKey(list[cursor]);
  if (key !== shownKey) {
    shownKey = key;
    clearTimeout(detailTimer);
    // A short wait, so holding j doesn't ask for every row's diff
    detailTimer = setTimeout(() => loadDetail(), 80);
  }
}

// ------------------------------------------------------------ the highlighted one's diff
let shownKey = "";
let detailTimer;
let asked = 0; // only the latest answer is shown

async function loadDetail(fromTop = true) {
  const r = rows()[cursor];
  const mine = ++asked;
  let text = "";
  try {
    if (!r) text = "";
    else if (r.kind === "file") {
      const f = r.file;
      text = await diff(f.change.path, f.group === "staged", f.group === "untracked");
      if (!text) text = f.change.from ? `Renamed from ${f.change.from}` : "(no changes to show)";
    } else if (r.kind === "commit") text = cut(await git(["show", "--format=%B", "--stat", "--patch", r.commit.hash]));
    else if (r.kind === "stash") text = cut(await git(["stash", "show", "--stat", "--patch", r.stash.name]));
    else {
      const b = r.branch;
      text = `${b.name}${b.upstream ? ` → ${b.upstream} ${b.track}` : " (no upstream)"}\n\nLast commit: ${b.subject}\n${ago(b.date)}`;
    }
  } catch (e) {
    text = e.message;
  }
  if (mine !== asked) return;
  const el = $("detail");
  el.innerHTML = text.split("\n").map((line) => `<span class="${lineKind(line)}">${esc(line)}</span>`).join("\n");
  if (fromTop) el.scrollTo({ top: 0 });
}

// ------------------------------------------------------------ doing things
function showView(to) {
  view = to;
  cursor = 0;
  render();
  load(to);
}

function move(to) {
  cursor = Math.max(0, Math.min(rows().length - 1, to));
  render();
}

/** The review page for the highlighted row: all changes (at its file), a commit, a stash */
function reviewRow() {
  const r = rows()[cursor];
  const name = project?.name ?? "";
  if (view === "changes") {
    if (!st?.changes.length) return td.ui.say("Nothing to review: the working tree is clean.");
    td.ui.openReview({
      title: "Uncommitted changes", subtitle: `${name} · ${st.branch.name ?? "detached HEAD"}`, diff: () => review("changes"),
      viewedKey: `changes:${project?.path}`, startFile: r?.kind === "file" ? r.file.change.path : undefined,
    });
  } else if (r?.kind === "commit") {
    const c = r.commit;
    td.ui.openReview({ title: `${c.short} ${c.subject}`, subtitle: `${c.author} · ${ago(c.date)} · ${name}`, diff: () => review(c.hash), viewedKey: `commit:${c.hash}` });
  } else if (r?.kind === "stash") {
    const s = r.stash;
    td.ui.openReview({ title: `${s.name} ${s.subject}`, subtitle: name, diff: () => review(s.name), viewedKey: `stash:${project?.path}:${s.subject}` });
  } else if (r?.kind === "branch") {
    td.ui.say("A branch has no diff of its own: review its commits in Commits (Tab)");
  }
}

const scrollDetail = (pages) => $("detail").scrollBy({ top: pages * ($("detail").clientHeight * 0.8) });

td.on("key", ({ action }) => {
  const i = views.indexOf(view);
  switch (action) {
    case "down": return move(cursor + 1);
    case "up": return move(cursor - 1);
    case "first": return move(0);
    case "last": return move(rows().length - 1);
    case "open": case "review": return reviewRow();
    case "next-list": return showView(views[(i + 1) % views.length]);
    case "previous-list": return showView(views[(i + views.length - 1) % views.length]);
    case "page-down": return scrollDetail(1);
    case "page-up": return scrollDetail(-1);
    case "refresh":
      td.ui.say("refreshed");
      return load().then(() => loadDetail());
  }
});

td.on("setup", (s) => {
  setup = s;
  if (view === "commits") load("commits");
});
td.on("shown", () => {
  visible = true;
  load().then(() => loadDetail(false));
});
td.on("hidden", () => (visible = false));

document.addEventListener("click", (e) => {
  const seg = e.target.closest("[data-view]");
  if (seg) return showView(seg.dataset.view);
  if (e.target.closest("#setup")) return td.setup.edit();
  const row = e.target.closest("[data-i]");
  if (row) move(Number(row.dataset.i));
});
document.addEventListener("dblclick", (e) => e.target.closest("[data-i]") && reviewRow());

// The branch line is always shown; the changes follow edits: look again every 3 seconds
render();
load("changes");
setInterval(() => {
  if (!visible) return;
  load("changes").then(() => view === "changes" && loadDetail(false));
}, 3000);
