// The Pull requests view: the open PRs that concern you in every repo you're in (to review
// again, to review, reviewed, yours) on top, the highlighted one's details below, like fzf with
// a preview. Its review page can comment, suggest, answer threads and approve or request
// changes. Read and written with the GitHub CLI (gh), so it uses your gh login.
import {
  aboutFrom, ago, checkSign, newer, contentsPath, descriptionHtml, DRAFT_MUTATION, failedStep, filterPrs, FILTERS, isStale, logTail, mergeBlocker, PEOPLE_QUERY,
  peopleFrom, PR_QUERY, READY_MUTATION, REPLY_MUTATION, RESOLVE_MUTATION, reviewersFrom, reviewPayload, reviewText, SEARCH_QUERY, searches, sortPrs, threadsFrom,
  UNRESOLVE_MUTATION,
} from "./prs.js";

const td = window.thumbdeck;
const esc = td.escape;
const $ = (id) => document.getElementById(id);
const folder = td.context.plugin.folder;

let settings = await td.settings.get();
let data = null; // { demo, user, prs }
let error = "";
let loading = false;
let cursor = 0; // in the shown (filtered) list
let visible = true;
let filter = "all";
let fetchedAt = 0;
// The backend (when Node runs it) says how many wait for you and tells what changed
let backendUp = false;
await td.backend.call("hello").then(() => (backendUp = true), () => {});

/** Run the GitHub CLI; its output, or an error with its message */
async function gh(args, input) {
  let r;
  try {
    r = await td.exec(["gh", ...args], { timeout: 60_000, ...(input === undefined ? {} : { input }) });
  } catch (e) {
    throw new Error(/couldn't run/.test(e.message) ? "the GitHub CLI (gh) isn't installed" : e.message);
  }
  if (r.code !== 0) throw new Error(`gh: ${(r.stderr.split("\n").find((l) => l.trim()) ?? "failed").trim()}`);
  return r.stdout;
}
const graphql = async (query, vars) => {
  const args = ["api", "graphql", "-f", `query=${query}`];
  for (const [k, v] of Object.entries(vars)) args.push(typeof v === "number" ? "-F" : "-f", `${k}=${v}`);
  return JSON.parse(await gh(args));
};

const readJson = async (file) => JSON.parse(await td.fs.read(`${folder}/testdata/${file}`));
const demo = () => String(settings.repos ?? "").trim() === "demo";

/** The PRs that concern you, with their notifications (all asked at once) */
async function fetchPrs() {
  if (demo()) {
    const s = { ...settings, trim_suffix: "_corp" };
    return { demo: true, user: "me", prs: sortPrs(await readJson("search.json"), await readJson("notifications.json"), "me_corp", s) };
  }
  const q = searches(settings.repos);
  const [user, prs, notifications] = await Promise.all([
    gh(["api", "user", "--jq", ".login"]),
    graphql(SEARCH_QUERY, q),
    // Unread only; not knowing them just leaves the bells off
    gh(["api", "notifications"]).catch(() => "[]"),
  ]);
  if (!prs?.data) throw new Error("GitHub's answer had no PRs in it");
  let unread = [];
  try {
    unread = JSON.parse(notifications);
  } catch {}
  return { demo: false, user: user.trim(), prs: sortPrs(prs, unread, user.trim(), settings) };
}

async function refresh() {
  if (loading) return;
  loading = true;
  render();
  try {
    data = await fetchPrs();
    fetchedAt = Date.now();
    details.clear();
    // The avatar holds up a sign while PRs wait for your review; the Plugins pane says how many
    const waiting = data.prs.filter((p) => p.category === "review" || p.category === "re-review").length;
    if (!backendUp) {
      td.ui.mood("review", waiting);
      td.ui.status(waiting ? `${waiting} to review` : null);
    }
    error = "";
    cursor = Math.min(cursor, Math.max(0, shown().length - 1));
  } catch (e) {
    error = e.message;
  } finally {
    loading = false;
    render();
  }
}

// ------------------------------------------------------------ drawing
const GROUPS = [["re-review", "To review again"], ["review", "To review"], ["reviewed", "Reviewed by you"], ["mine", "Yours"]];
const GROUP_COLOR = { "re-review": "var(--red)", review: "var(--yellow)", reviewed: "var(--purple)", mine: "var(--green)" };
const SIGN = { pass: "✓", run: "●", fail: "✗", none: "○" };
const SIGN_WORDS = { pass: "checks pass", run: "checks running", fail: "checks fail", none: "no checks" };
const VERDICT = { APPROVED: ["approved", "green"], CHANGES_REQUESTED: ["changes requested", "red"], COMMENTED: ["commented", "blue"], PENDING: ["asked", "yellow"], DISMISSED: ["dismissed", "grey"] };
const FACE_COLORS = ["purple", "blue", "orange", "aqua", "yellow", "green", "red"];
const faceColor = (name) => `var(--${FACE_COLORS[[...name].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % FACE_COLORS.length]})`;
const COMMENTS_ICON = `<svg class="cmi" viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z"/></svg>`;
const shown = () => filterPrs(data?.prs ?? [], filter);
const DOT = { APPROVED: "var(--green)", CHANGES_REQUESTED: "var(--red)", COMMENTED: "var(--blue)", PENDING: "var(--yellow)", DISMISSED: "var(--grey)" };
const faces = (reviewers) => `<span class="td-faces">${reviewers.map((r) =>
  `<span class="td-face" style="background: ${faceColor(r.name)}; --dot: ${DOT[r.state] ?? "transparent"}" title="@${esc(r.name)}: ${esc(reviewText(r.state))}">${esc(r.name[0]?.toUpperCase() ?? "?")}</span>`).join("")}</span>`;
const SIGN_COLOR = { pass: "td-green", run: "td-blue", fail: "td-red", none: "td-grey" };

function render() {
  const where = demo() ? "sample PRs, not from GitHub" : String(settings.repos ?? "").trim() || "every repo you're in";
  const all = data?.prs ?? [];
  $("bar").innerHTML = `<strong>Pull requests</strong>
    <span class="${demo() ? "yellow" : "dim"}">${esc(where)}${data ? ` · ${all.length} for @${esc(data.user)}` : ""}</span>
    <span class="td-chips">${FILTERS.map(([id, name]) => `<button class="td-chip" aria-pressed="${filter === id}" data-filter="${id}">${esc(name)} <b>${filterPrs(all, id).length}</b></button>`).join("")}<kbd>Space f</kbd></span>
    <span class="spacer"></span>
    <span class="dim">${loading ? "refreshing…" : fetchedAt ? ago(new Date(fetchedAt).toISOString()) : ""}</span>
    <button class="tool" id="refresh" title="Refresh (R)">↻ <kbd>R</kbd></button>`;
  $("error").hidden = !error;
  $("error").textContent = error;

  const list = shown();
  if (!list.length) {
    $("rows").innerHTML = `<li class="td-empty">${data ? (all.length ? "Nothing here: f shows the others." : "No open PRs that concern you.") : error ? "" : "Asking GitHub…"}</li>`;
    $("details").hidden = true;
    return;
  }
  let html = "";
  for (const [g, name] of GROUPS) {
    const items = list.filter((p) => p.category === g);
    if (!items.length) continue;
    html += `<li class="td-group" style="--c: ${GROUP_COLOR[g]}">${name} <span class="n">${items.length}</span></li>`;
    for (const p of items) {
      const i = list.indexOf(p);
      const sign = checkSign(p.checks);
      html += `<li class="td-row" aria-selected="${i === cursor}" data-i="${i}">
        <span class="bell" title="${p.notification ? "unread notification" : ""}">${p.notification ? "🔔" : ""}</span>
        <span class="td-l1"><span class="td-title">${esc(p.title)}</span>${p.draft ? `<span class="draft">draft</span>` : ""}</span>
        <span class="td-side"><span class="state"><span class="${SIGN_COLOR[sign]}" title="${SIGN_WORDS[sign]}">${SIGN[sign]}</span><span title="comments">${COMMENTS_ICON}${p.comments}</span>${p.mergeable === "CONFLICTING" ? `<span class="td-red" title="merge conflicts">⚠</span>` : ""}${isStale(p.updated, settings.stale_days) ? `<span class="td-yellow" title="stale">⏳</span>` : ""}</span>${faces(p.reviewers)}</span>
        <span class="td-l2"><span class="repo">${esc(p.repo)}</span><span>#${p.number}</span><span>@${esc(p.author)}</span><span>${ago(p.updated)}</span></span></li>`;
    }
  }
  $("rows").innerHTML = html;
  $("rows").querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
  renderDetails(list[cursor]);
}

/** The highlighted PR: its verdicts and checks first, then the start of its description */
function renderDetails(p) {
  $("details").hidden = !p;
  if (!p) return;
  const more = details.get(p.url);
  if (!more) loadDetails(p);
  const sign = checkSign(p.checks);
  const pills = [
    `<span class="td-pill ${SIGN_COLOR[sign]}">${SIGN[sign]} ${SIGN_WORDS[sign]}</span>`,
    p.mergeable === "CONFLICTING" ? `<span class="td-pill td-red">⚠ merge conflicts</span>` : "",
    isStale(p.updated, settings.stale_days) ? `<span class="td-pill td-yellow">⏳ stale</span>` : "",
    p.notification ? `<span class="td-pill td-yellow">🔔 unread</span>` : "",
    `<span class="td-pill td-grey">${COMMENTS_ICON}${p.comments}${p.lastComment ? ` · last @${esc(p.lastComment.author)} ${ago(p.lastComment.updated)}` : ""}</span>`,
  ].join("");
  const reviewers = p.reviewers.length
    ? p.reviewers.map((r) => { const [word, color] = VERDICT[r.state] ?? [r.state.toLowerCase(), "grey"];
        return `<div class="td-item">${faces([r])}@${esc(r.name)}<span class="r td-${color}">${esc(word)}</span></div>`; }).join("")
    : `<div class="td-muted">No reviewers asked</div>`;
  const failed = failures.get(p.url) ?? [];
  const checks = more?.about?.checks?.length
    ? more.about.checks.map((c) => { const s = { success: "pass", failure: "fail", pending: "run", neutral: "none" }[c.state] ?? "none";
        const f = c.state === "failure" ? failed.find((x) => x.name === c.name) : null;
        return `<div class="td-item"><span class="${SIGN_COLOR[s]}">${SIGN[s]}</span>${esc(c.name)}${c.detail ? `<span class="r td-muted">${esc(c.detail)}</span>` : ""}${c.url && c.state === "failure" ? `<span class="r"><a href="#" data-url="${esc(c.url)}">log ↗</a></span>` : ""}</div>`
          + (f ? `<div class="failed">${f.reading ? `<span class="td-muted">Reading its log…</span>` : f.error ? `<span class="td-muted">${esc(f.error)}</span>`
            : `${f.step ? `<div>Failed at <span class="step">${esc(f.step)}</span></div>` : ""}${f.tail ? `<pre>${esc(f.tail)}</pre>` : ""}`}</div>` : ""); }).join("")
      + (more.about.checks.some((c) => c.state === "failure" && (c.run || c.job)) ? `<div class="td-actions"><button id="rerun">Re-run failed <kbd>Space r</kbd></button></div>` : "")
    : `<div class="td-muted">${more?.error ? esc(more.error) : more ? "No checks" : "Reading…"}</div>`;
  const block = more?.about ? mergeBlocker(more.about.merge, more.about.draft) : null;
  const mergeNote = block ? (block.why ? `<span class="td-muted merge-note">Can't merge yet: ${esc(block.why)}</span>` : `<button id="merge">Merge <kbd>Space m</kbd></button>${block.warn ? `<span class="td-yellow merge-note">${esc(block.warn)}</span>` : ""}`) : "";
  const mine = p.category === "mine";
  const description = more?.about ? descriptionHtml(more.about.description, esc) || `<p class="td-muted">No description.</p>` : `<p class="td-muted">${more?.error ? "" : "Reading…"}</p>`;
  // Each button beside what it acts on: the PR's under its title, a part's with that part
  $("details").innerHTML = `<h3>${esc(p.title)}${p.draft ? ` <span class="draft">draft</span>` : ""}${mine
      ? ` <button class="inline" id="title" title="Edit the title (i)">Edit <kbd>i</kbd></button><button class="inline" id="draft">${p.draft ? "Ready for review" : "Back to draft"} <kbd>Space d</kbd></button>` : ""}</h3>
    <div class="td-sub"><span class="repo">${esc(p.repo)}</span><span>#${p.number}</span><span>@${esc(p.author)}</span><span>${ago(p.updated)}</span>
      ${p.head ? `<span class="branch">${esc(p.head)}</span>→<span class="branch">${esc(p.base)}</span>` : ""}</div>
    <div class="td-actions"><button class="primary" id="review">Review it <kbd>Enter</kbd></button><button id="open">Open in the browser <kbd>gx</kbd></button>${mergeNote}</div>
    <div class="td-actions">${pills}</div>
    <div class="td-sect"><h5>Reviewers</h5>${reviewers}${mine ? `<button class="plus" id="reviewers" title="Ask someone to review it (Space u)">+ ask <kbd>Space u</kbd></button>` : ""}</div>
    <div class="td-sect"><h5>Checks</h5>${checks}</div>
    <div class="td-sect"><h5>Description${mine ? ` <button class="inline" id="body" title="Edit the description, as Markdown (cc)">Edit <kbd>cc</kbd></button>` : ""}</h5><div class="desc">${description}</div></div>
    ${p.labels.length ? `<div class="td-sect"><h5>Labels</h5><div class="td-actions">${p.labels.map((l) => `<span class="td-tag">${esc(l)}</span>`).join("")}</div></div>` : ""}
    <div class="td-muted url">${esc(p.url)}</div>`;
}

/** A PR's description and checks, read once (a moment after it's highlighted, so moving fast doesn't ask for each) */
const details = new Map(); // url -> { about } | { error }
let detailsTimer;
function loadDetails(p) {
  clearTimeout(detailsTimer);
  detailsTimer = setTimeout(() => readDetails(p), 250);
}
async function readDetails(p) {
  if (details.has(p.url) || !data) return;
  try {
    const [owner, name] = p.repo.split("/");
    const answer = data.demo ? await readJson("pr.json") : await graphql(PR_QUERY, { owner, name, number: p.number });
    const about = aboutFrom(answer, data.demo ? { ...settings, trim_suffix: "_corp" } : settings);
    if (data.demo) Object.assign(about, { title: p.title, draft: p.draft, merge: { ...about.merge, state: p.draft ? "DRAFT" : p.mergeable === "CONFLICTING" ? "DIRTY" : "CLEAN" } });
    details.set(p.url, { about });
    readFailures(p, about);
  } catch (e) {
    details.set(p.url, { error: `Couldn't read it: ${e.message}` });
  }
  if (shown()[cursor]?.url === p.url) renderDetails(p);
}

// ------------------------------------------------------------ doing things
function move(to) {
  cursor = Math.max(0, Math.min(shown().length - 1, to));
  render();
}

/** The next filter (f), the cursor kept on the same PR when it's still there */
function nextFilter(to) {
  const at = shown()[cursor];
  filter = to ?? FILTERS[(FILTERS.findIndex(([id]) => id === filter) + 1) % FILTERS.length][0];
  cursor = Math.max(0, shown().indexOf(at));
  render();
}

/** In the browser; its notification is marked read */
async function openPr(p) {
  if (!p) return;
  if (data?.demo) {
    p.notification = null;
    render();
    return td.ui.say(`demo: would open ${p.url}`);
  }
  td.ui.openUrl(p.url);
  if (p.notification) {
    try {
      await gh(["api", "-X", "PATCH", `notifications/threads/${p.notification}`]);
      p.notification = null;
      render();
    } catch (e) {
      td.ui.say(e.message, { error: true });
    }
  }
}

/** The review page for a PR (asked of gh, nothing is checked out): comments, threads, the verdict */
async function reviewPr(p) {
  if (!p || !data) return;
  const [owner, name] = p.repo.split("/");
  const vars = { owner, name, number: p.number };
  const s = data.demo ? { ...settings, trim_suffix: "_corp" } : settings;
  let details;
  td.ui.say(`Opening ${p.repo} #${p.number}…`);
  try {
    details = data.demo ? await readJson("pr.json") : await graphql(PR_QUERY, vars);
  } catch (e) {
    return td.ui.say(`Couldn't read ${p.repo} #${p.number}: ${e.message}`, { error: true });
  }
  const head = details?.data?.repository?.pullRequest?.headRefOid ?? "";
  // The demo keeps its threads here and changes them as you do
  let demoThreads = data.demo ? threadsFrom(details, s) : [];
  const review = {
    about: aboutFrom(details, s),
    threads: async () => (data.demo ? demoThreads : threadsFrom(await graphql(PR_QUERY, vars), s)),
    submit: async (r) => {
      if (data.demo) {
        for (const c of r.comments) demoThreads.push({ id: `D${Date.now()}${Math.random()}`, path: c.path, line: c.line, startLine: c.startLine ?? null, side: c.side, resolved: false, comments: [{ author: "me", body: c.body, createdAt: new Date().toISOString() }] });
        return td.ui.say(`demo: would post ${r.event.toLowerCase().replace("_", " ")} with ${r.comments.length} comment(s)`);
      }
      await gh(["api", "-X", "POST", `repos/${p.repo}/pulls/${p.number}/reviews`, "--input", "-"], JSON.stringify(reviewPayload(r, head)));
      refresh();
    },
    reply: async (thread, body) => {
      if (data.demo) return void demoThreads.find((t) => t.id === thread)?.comments.push({ author: "me", body, createdAt: new Date().toISOString() });
      await graphql(REPLY_MUTATION, { thread, body });
    },
    resolve: async (thread, resolved) => {
      if (data.demo) {
        const t = demoThreads.find((x) => x.id === thread);
        if (t) t.resolved = resolved;
        return;
      }
      await graphql(resolved ? RESOLVE_MUTATION : UNRESOLVE_MUTATION, { thread });
    },
  };
  td.ui.openReview({
    title: `${p.repo} #${p.number} ${p.title}`,
    subtitle: `@${p.author}${p.draft ? " · draft" : ""}`,
    diff: () => (data.demo ? td.fs.read(`${folder}/testdata/demo.diff`) : gh(["pr", "diff", String(p.number), "-R", p.repo])),
    // A file's whole text at the PR's head, for the parts the diff leaves out
    file: (path) => (data.demo
      ? td.fs.read(`${folder}/testdata/files/${path}`)
      : gh(["api", "-H", "Accept: application/vnd.github.raw", `repos/${p.repo}/contents/${contentsPath(path)}?ref=${head}`])),
    viewedKey: `pr:${p.repo}#${p.number}`,
    review,
  });
}

// ------------------------------------------------------------ asking
/** Asks in the view's box: choices to pick (typing narrows them; search(typed) adds more), a
 *  line (free), or a text (text: true, a textarea; Ctrl+Enter saves). The answer, or null (Esc). */
function ask({ label, value = "", choices = null, free = !choices, text = false, hint = "", search = null }) {
  const box = $("ask");
  const field = text ? $("ask-text") : $("ask-input");
  $("ask-input").hidden = text;
  $("ask-text").hidden = !text;
  $("ask-label").textContent = label;
  $("ask-ok").hidden = !!choices && !free;
  $("ask-ok").innerHTML = text ? "Save <kbd>Ctrl+Enter</kbd>" : "Save";
  const hintText = hint || (text ? "Markdown · Ctrl+Enter: save · Esc: cancel" : choices ? `↑↓ pick · Enter${free ? " (or what you typed)" : ""} · Esc: cancel` : "Enter: save · Esc: cancel");
  $("ask-hint").textContent = hintText;
  box.hidden = false;
  field.value = value;
  let at = 0;
  let found = [];
  let waiting = null;
  const matching = () => {
    const w = field.value.trim().toLowerCase();
    const mine = (choices ?? []).filter((c) => !w || field.value === value || `${c.label} ${c.note ?? ""}`.toLowerCase().includes(w));
    const have = new Set(mine.map((c) => c.value));
    return [...mine, ...found.filter((c) => !have.has(c.value))];
  };
  const draw = () => {
    if (text) return;
    const list = matching();
    at = Math.max(0, Math.min(at, list.length - 1));
    $("ask-choices").innerHTML = list.map((c, n) => `<li class="${n === at ? "cursor" : ""}" data-pick="${n}">${esc(c.label)}${c.note ? ` <span class="td-muted">${esc(c.note)}</span>` : ""}</li>`).join("");
    $("ask-choices").querySelector(".cursor")?.scrollIntoView({ block: "nearest" });
  };
  draw();
  field.focus();
  if (text) field.setSelectionRange(field.value.length, field.value.length);
  else field.select();
  return new Promise((resolve) => {
    const done = (answer) => {
      box.hidden = true;
      clearTimeout(waiting);
      field.removeEventListener("keydown", key);
      field.removeEventListener("input", typed);
      $("ask-choices").onmousedown = $("ask-ok").onclick = $("ask-cancel").onclick = null;
      $("ask-choices").innerHTML = "";
      field.blur();
      td.keys.take();
      resolve(answer);
    };
    const pick = () => {
      const list = matching();
      if (!text && list[at]) return done(list[at].value);
      if (free || text) return done(field.value);
    };
    const cancel = async () => {
      if (text && field.value !== value && !(await td.ui.confirm("Leave without saving what you changed?", { yes: "Leave it", no: "Keep writing" }))) return field.focus();
      done(null);
    };
    const key = (e) => {
      if (e.key === "Escape") return e.preventDefault(), cancel();
      if (text) {
        if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) return e.preventDefault(), done(field.value);
        return;
      }
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        at += e.key === "ArrowDown" ? 1 : -1;
        return draw();
      }
      if (e.key === "Enter") return e.preventDefault(), pick();
    };
    const typed = () => {
      at = 0;
      draw();
      clearTimeout(waiting);
      const q = field.value.trim();
      if (!search || q.length < 2) return (found = []), draw();
      waiting = setTimeout(async () => {
        $("ask-hint").textContent = `Searching for “${q}”…`;
        const got = await search(q).catch((e) => ({ choices: [], error: e.message }));
        if (box.hidden || field.value.trim() !== q) return;
        found = got.choices ?? [];
        $("ask-hint").textContent = got.error ? `Couldn't search: ${got.error}` : hintText;
        draw();
      }, 300);
    };
    field.addEventListener("keydown", key);
    field.addEventListener("input", typed);
    $("ask-ok").onclick = () => (text || (free && !choices) ? done(field.value) : pick());
    $("ask-cancel").onclick = cancel;
    $("ask-choices").onmousedown = (e) => {
      const li = e.target.closest("[data-pick]");
      if (!li) return;
      e.preventDefault();
      at = Number(li.dataset.pick);
      pick();
    };
  });
}

// ------------------------------------------------------------ changing a PR
/** Its details (merging, checks, its id…), read now if they aren't yet */
async function aboutOf(p) {
  let more = details.get(p.url);
  if (!more) {
    await readDetails(p);
    more = details.get(p.url);
  }
  if (more?.error) throw new Error(more.error);
  return more.about;
}

/** Does something to a PR, then reads it again (the backend looks too: what changed is told) */
async function doing(p, said, work) {
  try {
    await work();
    td.ui.say(`${p.repo} #${p.number}: ${said}`);
  } catch (e) {
    return td.ui.say(e.message, { error: true });
  }
  if (data.demo) return render(); // the sample, changed here only
  details.delete(p.url);
  failures.delete(p.url);
  td.backend.call("refresh").catch(() => {});
  await refresh();
}

/** Merges it: the repo's methods, its branch deleted or kept; what GitHub won't do now is said */
async function mergePr(p) {
  const about = await aboutOf(p).catch((e) => td.ui.say(e.message, { error: true }));
  if (!about) return;
  const { why, warn } = mergeBlocker(about.merge, about.draft);
  if (why) return td.ui.say(`GitHub won't merge #${p.number} now: ${why}`, { error: true });
  if (!about.merge.methods.length) return td.ui.say(`${p.repo} allows no way of merging`, { error: true });
  const method = about.merge.methods.length === 1 ? about.merge.methods[0].value
    : await ask({ label: `Merge ${p.repo} #${p.number} “${p.title}”${warn ? ` (${warn})` : ""}`, choices: about.merge.methods });
  if (!method) return;
  let remove = false;
  if (!about.merge.autoDelete && !about.merge.fork && about.head) {
    const branch = await ask({ label: `${about.merge.methods.find((m) => m.value === method).label}: its branch ${about.head}?`,
      choices: [{ value: "delete", label: "Delete the branch", note: about.head }, { value: "keep", label: "Keep it" }] });
    if (!branch) return;
    remove = branch === "delete";
  } else if (!(await td.ui.confirm(`${about.merge.methods.find((m) => m.value === method).label}: ${p.repo} #${p.number}?${warn ? `\n\n${warn[0].toUpperCase()}${warn.slice(1)}.` : ""}`, { yes: "Merge", no: "Not now" }))) return;
  await doing(p, `merged${remove ? `, ${about.head} deleted` : ""}`, async () => {
    if (data.demo) return removeDemo(p);
    // Refused if new commits came meanwhile (sha): what was looked at is what's merged
    await gh(["api", "-X", "PUT", `repos/${p.repo}/pulls/${p.number}/merge`, "-f", `merge_method=${method}`, "-f", `sha=${about.headOid}`]);
    if (remove) {
      await gh(["api", "-X", "DELETE", `repos/${p.repo}/git/refs/heads/${about.head.split("/").map(encodeURIComponent).join("/")}`])
        .catch((e) => td.ui.say(`merged, but ${about.head} wasn't deleted: ${e.message}`, { error: true }));
    }
  });
}

/** Re-runs its failed GitHub Actions jobs (each run's failed jobs, at once) */
async function rerunChecks(p) {
  const about = await aboutOf(p).catch((e) => td.ui.say(e.message, { error: true }));
  if (!about) return;
  const failed = about.checks.filter((c) => c.state === "failure");
  if (!failed.length) return td.ui.say(`no failed checks on #${p.number}`);
  const runs = [...new Set(failed.filter((c) => c.run).map((c) => c.run))];
  const jobs = failed.filter((c) => !c.run && c.job).map((c) => c.job);
  const others = failed.filter((c) => !c.run && !c.job).map((c) => c.name);
  if (!runs.length && !jobs.length) return td.ui.say(`${others.join(", ")}: not GitHub Actions, re-run it where it runs`, { error: true });
  await doing(p, `re-running ${failed.length - others.length} failed check${failed.length - others.length > 1 ? "s" : ""}${others.length ? ` (not ${others.join(", ")}: not GitHub Actions)` : ""}`, async () => {
    if (data.demo) return;
    for (const run of runs) await gh(["api", "-X", "POST", `repos/${p.repo}/actions/runs/${run}/rerun-failed-jobs`]);
    for (const job of jobs) await gh(["api", "-X", "POST", `repos/${p.repo}/actions/jobs/${job}/rerun`]);
  });
}

/** Marks a draft ready for review, or one back to draft (asked first) */
async function toggleDraft(p) {
  const about = await aboutOf(p).catch((e) => td.ui.say(e.message, { error: true }));
  if (!about) return;
  if (!about.draft && !(await td.ui.confirm(`Turn ${p.repo} #${p.number} back into a draft? Its reviewers aren't asked meanwhile.`, { yes: "Back to draft", no: "Keep it" }))) return;
  await doing(p, about.draft ? "ready for review" : "back to draft", async () => {
    if (data.demo) return void (p.draft = !about.draft, details.get(p.url).about.draft = p.draft);
    await graphql(about.draft ? READY_MUTATION : DRAFT_MUTATION, { id: about.id });
  });
}

/** Asks someone (or a team: org/team) to review it */
async function askReviewers(p) {
  const about = await aboutOf(p).catch((e) => td.ui.say(e.message, { error: true }));
  if (!about) return;
  const [owner, name] = p.repo.split("/");
  const asked = new Set(about.reviewers.filter((r) => r.state === "asked").map((r) => r.name));
  const choices = [
    ...about.suggested.map((login) => ({ value: login, label: login, note: "suggested" })),
    ...about.reviewers.filter((r) => r.state !== "asked").map((r) => ({ value: r.name, label: r.name, note: `again (${r.state})` })),
  ].filter((c, i, all) => !asked.has(c.value) && all.findIndex((x) => x.value === c.value) === i);
  const search = async (q) => (data.demo
    ? { choices: ["ann_corp", "bob_corp", "dana_corp", "erik_corp"].filter((l) => l.includes(q)).map((l) => ({ value: l, label: l })) }
    : { choices: peopleFrom(await graphql(PEOPLE_QUERY, { owner, name, q })) });
  const typed = await ask({ label: `Ask for a review of ${p.repo} #${p.number}${asked.size ? ` (asked: ${[...asked].join(", ")})` : ""}`, choices, free: true, search,
    hint: "Type a login (or several, or org/team): anyone who can review in the repo · ↑↓ pick · Enter · Esc" });
  const who = reviewersFrom(typed);
  if (!who.reviewers.length && !who.team_reviewers.length) return;
  const names = [...who.reviewers, ...who.team_reviewers].join(", ");
  await doing(p, `review asked of ${names}`, async () => {
    if (data.demo) return;
    await gh(["api", "-X", "POST", `repos/${p.repo}/pulls/${p.number}/requested_reviewers`, "--input", "-"], JSON.stringify(who));
  });
}

/** Edits its title (field: title) or description (body) */
async function editPr(p, field) {
  const about = await aboutOf(p).catch((e) => td.ui.say(e.message, { error: true }));
  if (!about) return;
  if (!about.canUpdate) return td.ui.say(`you can't edit ${p.repo} #${p.number}`, { error: true });
  const was = field === "title" ? about.title || p.title : about.description;
  const to = await ask(field === "title"
    ? { label: `Title of ${p.repo} #${p.number}`, value: was }
    : { label: `Description of ${p.repo} #${p.number}`, value: was, text: true });
  if (to === null || (field === "title" ? !to.trim() : false) || to.trim() === was.trim()) return to !== null && to.trim() === was.trim() && td.ui.say("nothing changed");
  await doing(p, field === "title" ? "title changed" : "description changed", async () => {
    if (data.demo) return void (field === "title" ? (p.title = to.trim()) : (details.get(p.url).about.description = to));
    await gh(["api", "-X", "PATCH", `repos/${p.repo}/pulls/${p.number}`, "--input", "-"], JSON.stringify({ [field]: field === "title" ? to.trim() : to }));
  });
}

function removeDemo(p) {
  data.prs = data.prs.filter((x) => x !== p);
}

// ------------------------------------------------------------ failed checks
/** url -> [{ name, step, tail, url, error }]: its failed GitHub Actions jobs, read once */
const failures = new Map();
async function readFailures(p, about) {
  const failed = about.checks.filter((c) => c.state === "failure" && c.job).slice(0, 3);
  if (!failed.length || failures.has(p.url)) return;
  failures.set(p.url, failed.map((c) => ({ name: c.name, url: c.url, step: "", tail: "", reading: true })));
  const got = await Promise.all(failed.map(async (c) => {
    try {
      const [job, log] = data.demo
        ? [await readJson("job.json"), await td.fs.read(`${folder}/testdata/job.log`)]
        : await Promise.all([gh(["api", `repos/${p.repo}/actions/jobs/${c.job}`]).then(JSON.parse), gh(["api", `repos/${p.repo}/actions/jobs/${c.job}/logs`]).catch(() => "")]);
      return { name: c.name, url: c.url, step: failedStep(job), tail: logTail(log) };
    } catch (e) {
      return { name: c.name, url: c.url, step: "", tail: "", error: e.message };
    }
  }));
  failures.set(p.url, got);
  if (shown()[cursor]?.url === p.url) renderDetails(p);
}
// The "refreshed 2m ago" stays right
setInterval(() => visible && !loading && data && render(), 60_000);

const scrollDetails = (pages) => $("details").scrollBy({ top: pages * ($("details").clientHeight * 0.8) });

td.on("key", ({ action }) => {
  const p = shown()[cursor];
  switch (action) {
    case "down": return move(cursor + 1);
    case "up": return move(cursor - 1);
    case "first": return move(0);
    case "last": return move(shown().length - 1);
    case "filter": return nextFilter();
    case "open": case "review": case "diff": return reviewPr(p);
    case "yank":
      if (!p?.url) return td.ui.say("No pull request here");
      return (td.ui.copy ? td.ui.copy(p.url) : navigator.clipboard.writeText(p.url)).then(() => td.ui.say(`copied ${p.url}`), () => td.ui.say("couldn't copy", { error: true }));
    case "outside": return openPr(p);
    case "page-down": return scrollDetails(1);
    case "page-up": return scrollDetails(-1);
    case "refresh": return refresh();
  }
  if (!p || !$("ask").hidden) return;
  switch (action) {
    case "merge": return mergePr(p);
    case "rerun": return rerunChecks(p);
    case "draft": return toggleDraft(p);
    case "reviewers": return askReviewers(p);
    case "edit": return editPr(p, "title");
    case "change": return editPr(p, "body");
  }
});
// Something changed on GitHub (the backend saw it): look again, if shown
td.backend.on("changed", () => visible && refresh());
td.on("settings", (s) => {
  settings = s;
  refresh();
});
td.on("shown", () => (visible = true));
td.on("hidden", () => (visible = false));

document.addEventListener("click", (e) => {
  const p = shown()[cursor];
  const chip = e.target.closest("[data-filter]");
  if (chip) return nextFilter(chip.dataset.filter);
  if (e.target.closest("#refresh")) return refresh();
  if (e.target.closest("#review")) return reviewPr(p);
  if (e.target.closest("#open")) return openPr(p);
  const link = e.target.closest("[data-url]");
  if (link) return e.preventDefault(), td.ui.openUrl(link.dataset.url);
  if (!$("ask").hidden) return;
  if (e.target.closest("#merge")) return mergePr(p);
  if (e.target.closest("#rerun")) return rerunChecks(p);
  if (e.target.closest("#draft")) return toggleDraft(p);
  if (e.target.closest("#reviewers")) return askReviewers(p);
  if (e.target.closest("#title")) return editPr(p, "title");
  if (e.target.closest("#body")) return editPr(p, "body");
  const row = e.target.closest("[data-i]");
  if (row) move(Number(row.dataset.i));
});
document.addEventListener("dblclick", (e) => e.target.closest("[data-i]") && reviewPr(shown()[cursor]));

// The list's look comes from thumbdeck's kit (0.8.0 on); an older thumbdeck draws it plainer
if (newer("0.8.0", td.context.thumbdeck)) td.ui.say("Pull requests looks its best in thumbdeck 0.8 or newer: update thumbdeck");

// Fetch now, then every few minutes while the view is shown
refresh();
setInterval(() => visible && refresh(), Math.max(1, settings.refresh_minutes) * 60_000);
