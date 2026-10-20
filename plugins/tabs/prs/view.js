// The Pull requests view: the open PRs that concern you in every repo you're in (to review
// again, to review, reviewed, yours) on top, the highlighted one's details below, like fzf with
// a preview. Its review page can comment, suggest, answer threads and approve or request
// changes. Read and written with the GitHub CLI (gh), so it uses your gh login.
import {
  aboutFrom, ago, checkSign, newer, contentsPath, descriptionHtml, filterPrs, FILTERS, isStale, PR_QUERY, REPLY_MUTATION, RESOLVE_MUTATION,
  reviewPayload, reviewText, SEARCH_QUERY, searches, sortPrs, threadsFrom, UNRESOLVE_MUTATION,
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
    td.ui.mood("review", waiting);
    td.ui.status(waiting ? `${waiting} to review` : null);
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
  const checks = more?.about?.checks?.length
    ? more.about.checks.map((c) => { const s = { success: "pass", failure: "fail", pending: "run", neutral: "none" }[c.state] ?? "none";
        return `<div class="td-item"><span class="${SIGN_COLOR[s]}">${SIGN[s]}</span>${esc(c.name)}${c.detail ? `<span class="r td-muted">${esc(c.detail)}</span>` : ""}</div>`; }).join("")
    : `<div class="td-muted">${more?.error ? esc(more.error) : more ? "No checks" : "Reading…"}</div>`;
  const description = more?.about ? descriptionHtml(more.about.description, esc) || `<p class="td-muted">No description.</p>` : `<p class="td-muted">${more?.error ? "" : "Reading…"}</p>`;
  $("details").innerHTML = `<h3>${esc(p.title)}${p.draft ? ` <span class="draft">draft</span>` : ""}</h3>
    <div class="td-sub"><span class="repo">${esc(p.repo)}</span><span>#${p.number}</span><span>@${esc(p.author)}</span><span>${ago(p.updated)}</span>
      ${p.head ? `<span class="branch">${esc(p.head)}</span>→<span class="branch">${esc(p.base)}</span>` : ""}</div>
    <div class="td-actions">${pills}</div>
    <div class="td-sect"><h5>Reviewers</h5>${reviewers}</div>
    <div class="td-sect"><h5>Checks</h5>${checks}</div>
    <div class="td-sect"><h5>Description</h5><div class="desc">${description}</div></div>
    ${p.labels.length ? `<div class="td-sect"><h5>Labels</h5><div class="td-actions">${p.labels.map((l) => `<span class="td-tag">${esc(l)}</span>`).join("")}</div></div>` : ""}
    <div class="td-actions"><button class="primary" id="review">Review it <kbd>Enter</kbd></button><button id="open">Open in the browser <kbd>gx</kbd></button></div>
    <div class="td-muted url">${esc(p.url)}</div>`;
}

/** A PR's description and checks, read once (a moment after it's highlighted, so moving fast doesn't ask for each) */
const details = new Map(); // url -> { about } | { error }
let detailsTimer;
function loadDetails(p) {
  clearTimeout(detailsTimer);
  detailsTimer = setTimeout(async () => {
    if (details.has(p.url) || !data) return;
    try {
      const [owner, name] = p.repo.split("/");
      const answer = data.demo ? await readJson("pr.json") : await graphql(PR_QUERY, { owner, name, number: p.number });
      details.set(p.url, { about: aboutFrom(answer, data.demo ? { ...settings, trim_suffix: "_corp" } : settings) });
    } catch (e) {
      details.set(p.url, { error: `Couldn't read it: ${e.message}` });
    }
    if (shown()[cursor]?.url === p.url) renderDetails(p);
  }, 250);
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
});
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
  const row = e.target.closest("[data-i]");
  if (row) move(Number(row.dataset.i));
});
document.addEventListener("dblclick", (e) => e.target.closest("[data-i]") && reviewPr(shown()[cursor]));

// The list's look comes from thumbdeck's kit (0.8.0 on); an older thumbdeck draws it plainer
if (newer("0.8.0", td.context.thumbdeck)) td.ui.say("Pull requests looks its best in thumbdeck 0.8 or newer: update thumbdeck");

// Fetch now, then every few minutes while the view is shown
refresh();
setInterval(() => visible && refresh(), Math.max(1, settings.refresh_minutes) * 60_000);
