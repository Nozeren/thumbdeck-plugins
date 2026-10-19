// The Pull requests view: the open PRs that concern you in every repo you're in (to review
// again, to review, reviewed, yours) on top, the highlighted one's details below, like fzf with
// a preview. Its review page can comment, suggest, answer threads and approve or request
// changes. Read and written with the GitHub CLI (gh), so it uses your gh login.
import {
  aboutFrom, ago, categoryLabel, checksText, contentsPath, isStale, PR_QUERY, REPLY_MUTATION, RESOLVE_MUTATION,
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
let cursor = 0;
let visible = true;

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
    // The avatar holds up a sign while PRs wait for your review; the Plugins pane says how many
    const waiting = data.prs.filter((p) => p.category === "review" || p.category === "re-review").length;
    td.ui.mood("review", waiting);
    td.ui.status(waiting ? `${waiting} to review` : null);
    error = "";
    cursor = Math.min(cursor, Math.max(0, data.prs.length - 1));
  } catch (e) {
    error = e.message;
  } finally {
    loading = false;
    render();
  }
}

// ------------------------------------------------------------ drawing
function render() {
  const where = demo() ? "sample PRs, not from GitHub" : String(settings.repos ?? "").trim() || "every repo you're in";
  $("bar").innerHTML = `<strong>Pull requests</strong>
    <span class="${demo() ? "yellow" : "dim"}">${esc(where)}</span>
    <span class="dim">${data ? `${data.prs.length} for @${esc(data.user)}` : ""}</span>
    <span class="spacer"></span>
    ${loading ? `<span class="dim">refreshing…</span>` : ""}
    <button class="tool" id="refresh" title="Refresh (r)">↻ <kbd>r</kbd></button>`;
  $("error").hidden = !error;
  $("error").textContent = error;

  const prs = data?.prs ?? [];
  $("rows").innerHTML = prs.length
    ? prs.map((p, i) => `<li class="row${i === cursor ? " cursor" : ""}" data-i="${i}">
        <span class="bell" title="${p.notification ? "unread notification" : ""}">${p.notification ? "🔔" : ""}</span>
        <span class="cat ${p.category}">${categoryLabel[p.category]}</span>
        <span class="repo" title="${esc(p.repo)}">${esc(p.repo)}</span>
        <span class="num ${p.category}">#${p.number}</span>
        <span class="title${p.draft ? " draft" : ""}">${esc(p.title)}</span>
        <span class="author">@${esc(p.author)}</span></li>`).join("")
    : `<li class="empty">${data ? "No open PRs that concern you." : error ? "" : "Asking GitHub…"}</li>`;
  $("rows").querySelector(".cursor")?.scrollIntoView({ block: "nearest" });

  const p = prs[cursor];
  $("details").hidden = !p;
  if (!p) return;
  const flags = [
    p.draft ? `<span class="dim">DRAFT</span>` : "",
    isStale(p.updated, settings.stale_days) ? `<span class="yellow">⏰ STALE</span>` : "",
    p.mergeable === "CONFLICTING" ? `<span class="red">⚠ MERGE CONFLICTS</span>` : "",
  ].join("");
  const reviewers = p.reviewers.length
    ? p.reviewers.map((r) => `<div class="reviewer"><span class="state ${esc(r.state)}">@${esc(r.name)}</span> <span class="dim">${esc(reviewText(r.state))}</span></div>`).join("")
    : `<div class="dim reviewer">No reviewers assigned</div>`;
  $("details").innerHTML = `<strong class="big">${esc(p.title)}</strong>
    <dl>
      <dt>Repo</dt><dd class="repo">${esc(p.repo)}${p.head ? ` <span class="dim">· ${esc(p.head)} → ${esc(p.base)}</span>` : ""}</dd>
      <dt>Author</dt><dd>@${esc(p.author)}</dd>
      <dt>Updated</dt><dd class="yellow">${ago(p.updated)}</dd>
      <dt>Checks</dt><dd class="checks ${esc(p.checks)}">${checksText(p.checks)}</dd>
      ${p.labels.length ? `<dt>Labels</dt><dd>${p.labels.map((l) => `[${esc(l)}]`).join("  ")}</dd>` : ""}
      ${p.comments ? `<dt>Comments</dt><dd>${p.comments} ${p.lastComment ? `<span class="dim">(last: @${esc(p.lastComment.author)} · ${ago(p.lastComment.updated)})</span>` : ""}</dd>` : ""}
    </dl>
    <p class="flags">${flags}</p>
    <strong>Reviewers</strong>${reviewers}
    <p class="dim url">${esc(p.url)}</p>
    <p class="actions"><button class="link" id="review">Review it <kbd>v</kbd></button> <button class="link" id="open">Open in the browser <kbd>o</kbd></button></p>`;
}

// ------------------------------------------------------------ doing things
function move(to) {
  cursor = Math.max(0, Math.min((data?.prs.length ?? 1) - 1, to));
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

const scrollDetails = (pages) => $("details").scrollBy({ top: pages * ($("details").clientHeight * 0.8) });

td.on("key", ({ action }) => {
  const p = data?.prs[cursor];
  switch (action) {
    case "down": return move(cursor + 1);
    case "up": return move(cursor - 1);
    case "first": return move(0);
    case "last": return move((data?.prs.length ?? 0) - 1);
    case "open": case "review": return reviewPr(p);
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
  const p = data?.prs[cursor];
  if (e.target.closest("#refresh")) return refresh();
  if (e.target.closest("#review")) return reviewPr(p);
  if (e.target.closest("#open")) return openPr(p);
  const row = e.target.closest("[data-i]");
  if (row) move(Number(row.dataset.i));
});
document.addEventListener("dblclick", (e) => e.target.closest("[data-i]") && reviewPr(data?.prs[cursor]));

// Fetch now, then every few minutes while the view is shown
refresh();
setInterval(() => visible && refresh(), Math.max(1, settings.refresh_minutes) * 60_000);
