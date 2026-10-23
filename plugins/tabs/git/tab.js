// The Git tab: the project's repo at a glance, read-only. Three lists (Tab switches): the
// uncommitted changes, recent commits, and branches with stashes; the highlighted one beside
// them: a file's diff, a commit's message, files and diff, a branch against main. In Commits, v
// picks a run of commits to see together, as a pull request shows them. Keys come from thumbdeck
// as actions (plugin.toml [keys.git], and [keys.visual] while picking).
import {
  ago, BRANCH_FORMAT, cut, diffLines, groupChanges, LOG_STAT_ARGS, mainBranch, parseBranches, parseLogStat,
  parseNumstat, parseStashes, parseStatus, pickRange, refNames, STASH_FORMAT, stateWord, track,
} from "./git.js";
import { before, git, notIn, review } from "./repo.js";

const td = window.thumbdeck;
const esc = td.escape;
const $ = (id) => document.getElementById(id);
const project = td.context.project;

// ------------------------------------------------------------ reading the repo
async function status() {
  const s = parseStatus(await git(["status", "--porcelain=v1", "-b", "-z", "--untracked-files=all"]));
  let fetched = null;
  try {
    const dir = (await git(["rev-parse", "--git-dir"])).trim();
    fetched = (await td.fs.stat(`${dir}/FETCH_HEAD`))?.modified ?? null;
  } catch {}
  // Each file's added and removed lines
  const [unstaged, staged] = await Promise.all([
    git(["diff", "--numstat"]).catch(() => ""),
    git(["diff", "--cached", "--numstat"]).catch(() => ""),
  ]);
  return { ...s, fetched, stats: { changes: parseNumstat(unstaged), staged: parseNumstat(staged) } };
}

async function diff(file, staged, untracked) {
  if (untracked) return cut(await git(["diff", "--no-index", "--", "/dev/null", file], { exitOneIsFine: true }));
  return cut(await git(staged ? ["diff", "--cached", "--", file] : ["diff", "--", file]));
}

async function commitList(count) {
  try {
    return parseLogStat(await git(["log", `-n${Math.max(1, count)}`, ...LOG_STAT_ARGS]));
  } catch (e) {
    if (/does not have any commits/.test(e.message)) return []; // a repo without commits yet
    throw e;
  }
}

/** Branches (each against the main branch: ahead / behind, merged) and stashes */
async function branches() {
  const b = parseBranches(await git(["for-each-ref", "refs/heads", "--sort=-committerdate", BRANCH_FORMAT]));
  const stashes = parseStashes(await git(["stash", "list", STASH_FORMAT]));
  const main = mainBranch(b.map((x) => x.name));
  if (main) {
    const merged = new Set((await git(["branch", "--merged", main, "--format=%(refname:short)"]).catch(() => "")).split("\n").map((s) => s.trim()));
    await Promise.all(b.slice(0, 30).map(async (x) => {
      if (x.name === main) return;
      const [behind, ahead] = (await git(["rev-list", "--left-right", "--count", `${main}...${x.name}`]).catch(() => "0\t0")).trim().split(/\s+/).map(Number);
      Object.assign(x, { behind, ahead, merged: merged.has(x.name) });
    }));
  }
  return { branches: b, stashes, main };
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
let anchor = null; // the commit where picking started (v): it and the cursor's commit, and all between, go together

function rows() {
  if (view === "changes") return groupChanges(st?.changes ?? []).map((file) => ({ kind: "file", file }));
  if (view === "commits") return (commits ?? []).map((commit) => ({ kind: "commit", commit }));
  return [
    ...(refs?.branches ?? []).map((branch) => ({ kind: "branch", branch })),
    ...(refs?.stashes ?? []).map((stash) => ({ kind: "stash", stash })),
  ];
}

/** The picked commits as [newest, oldest] indexes in the list, while picking */
function picked() {
  return view === "commits" ? pickRange(commits ?? [], anchor, cursor) : null;
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
    else if (which === "commits") commits = await commitList(setup.commits);
    else refs = await branches();
    error = "";
  } catch (e) {
    error = e.message;
  }
  // The commit picking started from is gone (a rebase, a reset): stop picking
  if (anchor && !picked()) stopPicking(false);
  cursor = Math.min(cursor, Math.max(0, rows().length - 1));
  render();
}

// ------------------------------------------------------------ drawing
const counts = (stat) => (stat === null ? `<span class="td-muted">binary</span>` : stat ? `<span class="td-green">+${stat[0]}</span> <span class="td-red">−${stat[1]}</span>` : "");
const statOf = (f) => (f.group === "untracked" ? undefined : st?.stats?.[f.group === "staged" ? "staged" : "changes"]?.get(f.change.path));
const splitPath = (p) => (p.includes("/") ? [p.slice(0, p.lastIndexOf("/") + 1), p.slice(p.lastIndexOf("/") + 1)] : ["", p]);

function renderBar() {
  const b = st?.branch;
  let html = "";
  if (b) {
    html += `<strong class="branch">⎇ ${esc(b.name ?? "detached HEAD")}</strong>`;
    if (b.upstream) {
      html += `<span class="dim">→ ${esc(b.upstream)}</span>`;
      html += b.gone ? `<span class="td-chip td-red">upstream gone</span>` : track(b.ahead, b.behind) ? `<span class="td-chip td-yellow">${track(b.ahead, b.behind)}</span>` : `<span class="td-chip">up to date</span>`;
    } else if (b.name) html += `<span class="td-chip">no upstream</span>`;
    if (st.fetched) html += `<span class="dim">fetched ${ago(new Date(st.fetched).toISOString())}</span>`;
  }
  html += `<span class="spacer"></span>`;
  const g = groupChanges(st?.changes ?? []);
  const n = { changes: st ? g.length : null, commits: commits?.length ?? null, branches: refs ? refs.branches.length : null };
  const pick = picked();
  if (pick) html += `<span class="td-chip td-blue">${pick[1] - pick[0] + 1} picked <kbd>Esc</kbd></span>`;
  for (const v of views) html += `<button class="td-chip" aria-pressed="${v === view}" data-view="${v}">${viewName[v]}${n[v] !== null ? ` <b>${n[v]}</b>` : ""}</button>`;
  html += `<kbd title="Tab: the next list">Tab</kbd><button class="tool" id="setup" title="Set up this tab (Space S)">⚙ <kbd>Space S</kbd></button>`;
  $("bar").innerHTML = html;
}

function rowHtml(r, i, inPick) {
  const sel = `aria-selected="${i === cursor}" data-i="${i}"`;
  if (r.kind === "file") {
    const f = r.file;
    const s = f.state === "?" ? "N" : f.state;
    const [dir, name] = splitPath(f.change.path);
    const from = f.change.from ? `<span class="dim"> ← ${esc(f.change.from)}</span>` : "";
    return `<li class="td-row one" ${sel}><span class="state s${s}" title="${stateWord[f.state] ?? f.state}">${f.state === "?" ? "+" : f.state}</span>
      <span class="td-l1"><span class="td-title"><span class="dir">${esc(dir)}</span>${esc(name)}${from}</span></span>
      <span class="td-side">${f.group === "untracked" ? "new" : counts(statOf(f))}</span></li>`;
  }
  if (r.kind === "commit") {
    const c = r.commit;
    const chips = refNames(c.refs).map((n) => `<span class="ref${n === st?.branch?.name ? " head" : n.startsWith("tag: ") ? " tag" : ""}">${esc(n.replace(/^tag: /, "🏷 "))}</span>`).join("");
    return `<li class="td-row${inPick ? " picked" : ""}" ${sel}><span class="state td-blue">${inPick ? "▌" : ""}</span>
      <span class="td-l1"><span class="td-title">${esc(c.subject)}</span>${chips}</span>
      <span class="td-side">${c.stat.files ? `<span>${c.stat.files} file${c.stat.files === 1 ? "" : "s"}</span><span><span class="td-green">+${c.stat.added}</span> <span class="td-red">−${c.stat.removed}</span></span>` : ""}</span>
      <span class="td-l2"><span class="hash">${esc(c.short)}</span><span>${esc(c.author)}</span><span>${ago(c.date)}</span></span></li>`;
  }
  if (r.kind === "branch") {
    const b = r.branch;
    const vsMain = refs?.main && b.name !== refs.main && b.ahead !== undefined
      ? `<span class="td-chip" title="against ${esc(refs.main)}">↑${b.ahead} ↓${b.behind}</span>${b.merged ? `<span class="td-chip td-purple">merged</span>` : ""}` : "";
    const up = b.upstream ? `<span title="against ${esc(b.upstream)}">${esc(b.track.replace(/[[\]]/g, "")) || "↔ " + esc(b.upstream)}</span>` : "";
    return `<li class="td-row" ${sel}><span class="state td-green">${b.current ? "●" : ""}</span>
      <span class="td-l1"><span class="td-title${b.current ? " current" : ""}">${esc(b.name)}</span>${b.name === refs?.main ? `<span class="td-chip">main</span>` : ""}</span>
      <span class="td-side">${vsMain || up}</span>
      <span class="td-l2"><span>${esc(b.subject)}</span><span>${ago(b.date)}</span></span></li>`;
  }
  const s = r.stash;
  return `<li class="td-row" ${sel}><span class="state td-grey">≡</span>
    <span class="td-l1"><span class="td-title">${esc(s.subject)}</span></span><span class="td-side"></span>
    <span class="td-l2"><span>${esc(s.name)}</span><span>${ago(s.date)}</span></span></li>`;
}

function render() {
  renderBar();
  $("error").hidden = !error;
  $("error").textContent = error;
  const list = rows();
  const pick = picked();
  let html = "";
  list.forEach((r, i) => {
    const prev = list[i - 1];
    if (r.kind === "file" && (prev?.kind !== "file" || prev.file.group !== r.file.group)) {
      html += `<li class="td-group">${groupTitle[r.file.group]} <span class="n">${list.filter((x) => x.kind === "file" && x.file.group === r.file.group).length}</span></li>`;
    } else if (r.kind === "branch" && i === 0) html += `<li class="td-group">Branches <span class="n">${refs.branches.length}</span></li>`;
    else if (r.kind === "stash" && prev?.kind !== "stash") html += `<li class="td-group">Stashes <span class="n">${refs.stashes.length}</span></li>`;
    html += rowHtml(r, i, pick && i >= pick[0] && i <= pick[1]);
  });
  if (!list.length) {
    const looking = view === "changes" ? !st : view === "commits" ? !commits : !refs;
    const none = { changes: "Nothing to commit: the working tree is clean.", commits: "No commits yet.", branches: "No branches yet." }[view];
    html = `<li class="td-empty">${looking ? "Looking…" : none}</li>`;
  }
  $("rows").innerHTML = html;
  $("rows").querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
  $("preview").hidden = !list[cursor];
  const key = pick && pick[0] !== pick[1] ? `picked:${commits[pick[0]].hash}:${commits[pick[1]].hash}` : rowKey(list[cursor]);
  if (key !== shownKey) {
    shownKey = key;
    clearTimeout(detailTimer);
    // A short wait, so holding j doesn't ask for every row's diff
    detailTimer = setTimeout(() => loadDetail(), 80);
  }
}

// ------------------------------------------------------------ the highlighted one, beside the list
let shownKey = "";
let detailTimer;
let asked = 0; // only the latest answer is shown

/** A diff drawn like the review page: line numbers, added and removed lines, no git headers */
function diffHtml(text) {
  return diffLines(text).map((l) => {
    if (l.kind === "file") return `<div class="td-dfile">${esc(l.text)}</div>`;
    if (l.kind === "hunk") return `<div class="td-hunk">@@ ${esc(l.text)}</div>`;
    if (l.kind === "meta") return `<div class="dmeta">${esc(l.text)}</div>`;
    const sign = l.kind === "add" ? "+" : l.kind === "del" ? "−" : "";
    return `<div class="td-dl ${l.kind}"><span>${l.old ?? ""}</span><span>${l.new ?? ""}</span><span>${sign}</span><code>${esc(l.text)}</code></div>`;
  }).join("") || `<div class="dmeta">No changes to show.</div>`;
}
const filesHtml = (stats) => `<div class="files">${[...stats].map(([p, s]) => `<div class="f"><span class="p">${esc(p)}</span>${counts(s)}</div>`).join("")}</div>`;
// Under the title, before the message and files (they can be long)
const reviewButton = (what, more = "") => `<div class="td-actions"><button class="primary" id="review">Review ${what} <kbd>Enter</kbd></button>${more}</div>`;
const pickButton = `<button id="pick">Pick commits to see together <kbd>v</kbd></button>`;

/** Picked commits together: from before the oldest to the newest, the end result as a pull request shows it */
async function pickedHtml([first, last]) {
  const list = commits.slice(first, last + 1);
  const newest = list[0];
  const oldest = list.at(-1);
  const range = `${await before(oldest.hash)}..${newest.hash}`;
  const [numstat, patch, missing] = await Promise.all([
    git(["diff", "--numstat", "--find-renames", range]), review(range), notIn(list.slice(1).map((c) => c.hash), newest.hash),
  ]);
  const left = list.filter((c) => missing.includes(c.hash));
  const stats = parseNumstat(numstat);
  let added = 0, removed = 0;
  for (const s of stats.values()) if (s) (added += s[0]), (removed += s[1]);
  return `<div class="phead"><h3>${list.length} commits together</h3>
      <div class="sub"><span class="hash">${esc(oldest.short)}</span><span>to</span><span class="hash">${esc(newest.short)}</span><span>${ago(oldest.date)} to ${ago(newest.date)}</span></div>
      ${reviewButton(`the ${list.length} commits`, `<button id="pick">Stop picking <kbd>Esc</kbd></button>`)}
      ${left.length ? `<p class="td-orange">Not in this diff: ${left.map((c) => `<span class="hash">${esc(c.short)}</span> ${esc(c.subject)}`).join(", ")}. ${left.length === 1 ? "It's" : "They're"} on another branch, not in ${esc(newest.short)}'s history.</p>` : ""}
      <div class="td-sect"><h5>Commits · ${list.length}</h5><div class="files">${list.map((c) => `<div class="f${missing.includes(c.hash) ? " dim" : ""}"><span class="hash">${esc(c.short)}</span><span class="p">${esc(c.subject)}</span><span class="dim">${ago(c.date)}</span></div>`).join("")}</div></div>
      <div class="td-sect"><h5>${stats.size} file${stats.size === 1 ? "" : "s"} · <span class="td-green">+${added}</span> <span class="td-red">−${removed}</span></h5>${filesHtml(stats)}</div></div>
    <div class="td-diff">${diffHtml(patch)}</div>`;
}

async function loadDetail(fromTop = true) {
  const r = rows()[cursor];
  const pick = picked();
  const mine = ++asked;
  let html = "";
  try {
    if (pick && pick[0] !== pick[1]) html = await pickedHtml(pick);
    else if (!r) html = "";
    else if (r.kind === "file") {
      const f = r.file;
      const text = await diff(f.change.path, f.group === "staged", f.group === "untracked");
      html = `<div class="phead"><h3>${esc(f.change.path)}</h3>
          <div class="sub"><span class="s${f.state === "?" ? "N" : f.state}">${stateWord[f.state] ?? f.state}</span><span>${groupTitle[f.group].toLowerCase()}</span>${counts(statOf(f))}${f.change.from ? `<span>from ${esc(f.change.from)}</span>` : ""}</div>
          ${reviewButton("the changes")}</div>
        <div class="td-diff">${text ? diffHtml(text) : `<div class="dmeta">${f.change.from ? `Renamed from ${esc(f.change.from)}` : "No changes to show."}</div>`}</div>`;
    } else if (r.kind === "commit") {
      const c = r.commit;
      const [message, numstat, patch] = await Promise.all([
        git(["show", "-s", "--format=%B", c.hash]),
        git(["show", "--format=", "--numstat", "--find-renames", c.hash]),
        git(["show", "--format=", "--patch", "--find-renames", c.hash]).then(cut),
      ]);
      const body = message.trim().split("\n").slice(1).join("\n").trim();
      html = `<div class="phead"><h3>${esc(c.subject)}</h3>
          <div class="sub"><span class="hash">${esc(c.short)}</span><span>${esc(c.author)}</span><span>${ago(c.date)}</span>${refNames(c.refs).map((n) => `<span class="ref">${esc(n)}</span>`).join("")}</div>
          ${reviewButton("the commit", pick ? `<button id="pick">Stop picking <kbd>Esc</kbd></button>` : pickButton)}
          ${body ? `<p class="message">${esc(body)}</p>` : ""}
          <div class="td-sect"><h5>${c.stat.files} file${c.stat.files === 1 ? "" : "s"} · <span class="td-green">+${c.stat.added}</span> <span class="td-red">−${c.stat.removed}</span></h5>${filesHtml(parseNumstat(numstat))}</div></div>
        <div class="td-diff">${diffHtml(patch)}</div>`;
    } else if (r.kind === "stash") {
      const s = r.stash;
      const [numstat, patch] = await Promise.all([
        git(["stash", "show", "--numstat", s.name]),
        git(["stash", "show", "--patch", s.name]).then(cut),
      ]);
      html = `<div class="phead"><h3>${esc(s.subject)}</h3><div class="sub"><span>${esc(s.name)}</span><span>${ago(s.date)}</span></div>${reviewButton("the stash")}
          <div class="td-sect"><h5>Files</h5>${filesHtml(parseNumstat(numstat))}</div></div>
        <div class="td-diff">${diffHtml(patch)}</div>`;
    } else {
      const b = r.branch;
      const main = refs?.main;
      const own = main && b.name !== main ? await git(["log", "--format=%h%x1f%s%x1f%aI", "-n20", `${main}..${b.name}`]).catch(() => "") : "";
      const list = own.trim() ? own.trim().split("\n").map((l) => l.split("\x1f")) : [];
      html = `<div class="phead"><h3>${b.current ? "● " : ""}${esc(b.name)}</h3>
          <div class="sub">${b.upstream ? `<span>→ ${esc(b.upstream)}</span><span>${esc(b.track.replace(/[[\]]/g, "")) || "up to date"}</span>` : `<span>no upstream</span>`}
            ${main && b.name !== main ? `<span class="td-chip">↑${b.ahead} ↓${b.behind} against ${esc(main)}</span>${b.merged ? `<span class="td-chip td-purple">merged into ${esc(main)}</span>` : ""}` : ""}</div>
          <div class="td-sect"><h5>Last commit</h5><div>${esc(b.subject)} <span class="dim">· ${ago(b.date)}</span></div></div>
          ${list.length ? `<div class="td-sect"><h5>Not in ${esc(main)} yet · ${list.length}</h5><div class="files">${list.map(([h, s, d]) => `<div class="f"><span class="hash">${esc(h)}</span><span class="p">${esc(s)}</span><span class="dim">${ago(d)}</span></div>`).join("")}</div></div>` : ""}
          <p class="dim">A branch has no diff of its own: review its commits in Commits (Tab).</p></div>`;
    }
  } catch (e) {
    html = `<div class="phead"><p class="red">${esc(e.message)}</p></div>`;
  }
  if (mine !== asked) return;
  const el = $("preview");
  el.innerHTML = html;
  if (fromTop) el.scrollTo({ top: 0 });
}

// ------------------------------------------------------------ doing things
function showView(to) {
  stopPicking(false);
  view = to;
  cursor = 0;
  render();
  load(to);
}

function move(to) {
  cursor = Math.max(0, Math.min(rows().length - 1, to));
  render();
}

/** v in Commits: the commit here and the ones j / k reach go together */
function startPicking() {
  if (view !== "commits") return td.ui.say("Picking commits to see together is in Commits (Tab)");
  if (!commits?.[cursor]) return;
  anchor = commits[cursor].hash;
  td.keys.use("visual");
  render();
}

function stopPicking(draw = true) {
  if (!anchor) return;
  anchor = null;
  td.keys.use("git");
  if (draw) render();
}

/** The review page for the highlighted row: all changes (at its file), a commit, a stash; or
 *  the picked commits together */
function reviewRow() {
  const pick = picked();
  if (pick) {
    stopPicking();
    if (pick[0] !== pick[1]) return reviewCommits(commits.slice(pick[0], pick[1] + 1));
  }
  const r = rows()[cursor];
  const name = project?.name ?? "";
  if (view === "changes") {
    if (!st?.changes.length) return td.ui.say("Nothing to review: the working tree is clean.");
    td.ui.openReview({
      title: "Uncommitted changes", subtitle: `${name} · ${st.branch.name ?? "detached HEAD"}`, diff: () => review("changes"),
      viewedKey: `changes:${project?.path}`, startFile: r?.kind === "file" ? r.file.change.path : undefined, file: fileAt(null),
    });
  } else if (r?.kind === "commit") {
    const c = r.commit;
    td.ui.openReview({ title: `${c.short} ${c.subject}`, subtitle: `${c.author} · ${ago(c.date)} · ${name}`, diff: () => review(c.hash), viewedKey: `commit:${c.hash}`, file: fileAt(c.hash) });
  } else if (r?.kind === "stash") {
    const s = r.stash;
    td.ui.openReview({ title: `${s.name} ${s.subject}`, subtitle: name, diff: () => review(s.name), viewedKey: `stash:${project?.path}:${s.subject}`, file: fileAt(s.name) });
  } else if (r?.kind === "branch") {
    td.ui.say("A branch has no diff of its own: review its commits in Commits (Tab)");
  }
}

/** Commits (newest first) as one diff: what the oldest one's parent became in the newest */
function reviewCommits(list) {
  const newest = list[0];
  const oldest = list.at(-1);
  td.ui.openReview({
    title: `${list.length} commits: ${oldest.short}..${newest.short}`,
    subtitle: `from “${oldest.subject}” to “${newest.subject}” · ${project?.name ?? ""}`,
    diff: async () => review(`${await before(oldest.hash)}..${newest.hash}`),
    // Keyed by where it starts: picking newer commits later keeps what you viewed, and marks the
    // files whose changes are different now
    viewedKey: `commits:${oldest.hash}`,
    file: fileAt(newest.hash),
  });
}

/** A file's whole text, for the review page's hidden lines (f): in a commit, or in the working tree */
const fileAt = (rev) => async (path) => {
  const r = await td.exec(rev ? ["git", "show", `${rev}:${path}`] : ["cat", "--", path]);
  if (r.code !== 0) throw new Error(r.stderr.trim() || `can't read ${path}`);
  return r.stdout;
};

const scrollDetail = (pages) => $("preview").scrollBy({ top: pages * ($("preview").clientHeight * 0.8) });

td.on("key", ({ action }) => {
  const i = views.indexOf(view);
  switch (action) {
    case "down": return move(cursor + 1);
    case "up": return move(cursor - 1);
    case "first": return move(0);
    case "last": return move(rows().length - 1);
    case "open": case "review": case "diff": return reviewRow();
    case "visual": case "visual-line": return anchor ? stopPicking() : startPicking();
    case "leave": return stopPicking();
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
  if (e.target.closest("#review")) return reviewRow();
  if (e.target.closest("#pick")) return anchor ? stopPicking() : startPicking();
  const row = e.target.closest("[data-i]");
  if (!row) return;
  // Shift+click picks from the highlighted commit to this one
  if (e.shiftKey && !anchor) startPicking();
  move(Number(row.dataset.i));
});
document.addEventListener("dblclick", (e) => e.target.closest("[data-i]") && reviewRow());

// The list's look comes from thumbdeck's kit (0.8.0 on); an older thumbdeck draws it plainer
const older = (v) => { const [a, b] = String(v ?? "0").split(".").map(Number); return a === 0 && (b ?? 0) < 8; };
if (older(td.context.thumbdeck)) td.ui.say("Git looks its best in thumbdeck 0.8 or newer: update thumbdeck");

// The branch line is always shown; the changes follow edits: look again every 3 seconds
render();
load("changes");
// The other lists' counts in the bar, a moment later
setTimeout(() => (commitList(setup.commits).then((c) => ((commits = c), render())).catch(() => {}), branches().then((b) => ((refs = b), render())).catch(() => {})), 300);
setInterval(() => {
  if (!visible) return;
  load("changes").then(() => view === "changes" && loadDetail(false));
}, 3000);
