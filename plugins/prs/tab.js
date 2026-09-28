// The Pull requests tab: the repo's open PRs that concern you (to review again, to review,
// reviewed, yours) on top, the highlighted one's details below, like fzf with a preview.
// Read with the GitHub CLI (gh), so it uses your gh login.
import { ago, categoryLabel, checksText, isStale, QUERY, repoFromUrl, reviewText, sortPrs } from "./prs.js";

const td = window.thumbdeck;
const esc = td.escape;
const $ = (id) => document.getElementById(id);
const folder = td.context.plugin.folder;

let setup = await td.setup.get();
let data = null; // { repo, demo, user, prs }
let error = "";
let loading = false;
let cursor = 0;
let visible = true;

/** Run the GitHub CLI; its output, or an error with its message */
async function gh(args) {
  let r;
  try {
    r = await td.exec(["gh", ...args], { timeout: 60_000 });
  } catch (e) {
    throw new Error(/couldn't run/.test(e.message) ? "the GitHub CLI (gh) isn't installed" : e.message);
  }
  if (r.code !== 0) throw new Error(`gh: ${(r.stderr.split("\n").find((l) => l.trim()) ?? "failed").trim()}`);
  return r.stdout;
}

/** The setup's repo, or the one the project's origin remote points at */
async function repo() {
  if (setup.repo.trim()) return setup.repo.trim();
  const r = await td.exec(["git", "remote", "get-url", "origin"]);
  if (r.code !== 0) throw new Error("no git remote 'origin': set the repo in the tab setup (S)");
  const found = repoFromUrl(r.stdout);
  if (!found) throw new Error(`origin isn't a GitHub repo (${r.stdout.trim()}): set the repo in the tab setup (S)`);
  return found;
}

const readJson = async (file) => JSON.parse(await td.fs.read(`${folder}/testdata/${file}`));

/** The repo's PRs that concern you, with their notifications (all asked at once) */
async function fetchPrs(name) {
  if (name === "demo") {
    const s = { ...setup, trim_suffix: "_corp" };
    return { repo: "demo", demo: true, user: "me", prs: sortPrs(await readJson("repo.json"), await readJson("notifications.json"), "me_corp", s) };
  }
  const [owner, rest] = name.split("/");
  if (!owner || !rest) throw new Error(`'${name}' isn't owner/name`);
  const [user, prs, notifications] = await Promise.all([
    gh(["api", "user", "--jq", ".login"]),
    gh(["api", "graphql", "-f", `query=${QUERY}`, "-f", `owner=${owner}`, "-f", `name=${rest}`]),
    // Unread only; not knowing them just leaves the bells off
    gh(["api", `repos/${name}/notifications`]).catch(() => "[]"),
  ]);
  const response = JSON.parse(prs);
  if (!response?.data?.repository) throw new Error(`no repo ${name} on GitHub (or no access)`);
  let unread = [];
  try {
    unread = JSON.parse(notifications);
  } catch {}
  return { repo: name, demo: false, user: user.trim(), prs: sortPrs(response, unread, user.trim(), setup) };
}

async function refresh() {
  if (loading) return;
  loading = true;
  render();
  try {
    data = await fetchPrs(await repo());
    // The avatar holds up a sign while PRs wait for your review
    td.ui.mood("review", data.prs.filter((p) => p.category === "review" || p.category === "re-review").length);
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
  $("bar").innerHTML = `<strong>${esc(data?.repo ?? "…")}</strong>
    ${data?.demo ? `<span class="yellow">sample PRs, not from GitHub</span>` : ""}
    <span class="dim">${data ? `${data.prs.length} for @${esc(data.user)}` : ""}</span>
    <span class="spacer"></span>
    ${loading ? `<span class="dim">refreshing…</span>` : ""}
    <button class="tool" id="refresh" title="Refresh (r)">↻</button>
    <button class="tool" id="setup" title="Set up this tab (S)">⚙ setup</button>`;
  $("error").hidden = !error;
  $("error").textContent = error;

  const prs = data?.prs ?? [];
  $("rows").innerHTML = prs.length
    ? prs.map((p, i) => `<li class="row${i === cursor ? " cursor" : ""}" data-i="${i}">
        <span class="bell" title="${p.notification ? "unread notification" : ""}">${p.notification ? "🔔" : ""}</span>
        <span class="cat ${p.category}">${categoryLabel[p.category]}</span>
        <span class="author">@${esc(p.author)}</span>
        <span class="num ${p.category}">#${p.number}</span>
        <span class="title${p.draft ? " draft" : ""}">${esc(p.title)}</span></li>`).join("")
    : `<li class="empty">${data ? "No open PRs that concern you." : error ? "" : "Asking GitHub…"}</li>`;
  $("rows").querySelector(".cursor")?.scrollIntoView({ block: "nearest" });

  const p = prs[cursor];
  $("details").hidden = !p;
  if (!p) return;
  const flags = [
    p.draft ? `<span class="dim">DRAFT</span>` : "",
    isStale(p.updated, setup.stale_days) ? `<span class="yellow">⏰ STALE</span>` : "",
    p.mergeable === "CONFLICTING" ? `<span class="red">⚠ MERGE CONFLICTS</span>` : "",
  ].join("");
  const reviewers = p.reviewers.length
    ? p.reviewers.map((r) => `<div class="reviewer"><span class="state ${esc(r.state)}">@${esc(r.name)}</span> <span class="dim">${esc(reviewText(r.state))}</span></div>`).join("")
    : `<div class="dim reviewer">No reviewers assigned</div>`;
  $("details").innerHTML = `<strong class="big">${esc(p.title)}</strong>
    <dl>
      <dt>Author</dt><dd>@${esc(p.author)}</dd>
      <dt>Updated</dt><dd class="yellow">${ago(p.updated)}</dd>
      <dt>Checks</dt><dd class="checks ${esc(p.checks)}">${checksText(p.checks)}</dd>
      ${p.labels.length ? `<dt>Labels</dt><dd>${p.labels.map((l) => `[${esc(l)}]`).join("  ")}</dd>` : ""}
      ${p.comments ? `<dt>Comments</dt><dd>${p.comments} ${p.lastComment ? `<span class="dim">(last: @${esc(p.lastComment.author)} · ${ago(p.lastComment.updated)})</span>` : ""}</dd>` : ""}
    </dl>
    <p class="flags">${flags}</p>
    <strong>Reviewers</strong>${reviewers}
    <p class="dim url">${esc(p.url)} · <button class="link" id="review">Enter: review the changes</button> · <button class="link" id="open">o: open in the browser</button></p>`;
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

/** The review page for a PR's changes (asked of gh, nothing is checked out) */
function reviewPr(p) {
  if (!p || !data) return;
  const repoName = data.repo;
  td.ui.openReview({
    title: `#${p.number} ${p.title}`,
    subtitle: `@${p.author} · ${repoName}${p.draft ? " · draft" : ""}`,
    diff: () => (repoName === "demo" ? td.fs.read(`${folder}/testdata/demo.diff`) : gh(["pr", "diff", String(p.number), "-R", repoName])),
    viewedKey: `pr:${repoName}#${p.number}`,
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
td.on("setup", (s) => {
  setup = s;
  refresh();
});
td.on("shown", () => (visible = true));
td.on("hidden", () => (visible = false));

document.addEventListener("click", (e) => {
  const p = data?.prs[cursor];
  if (e.target.closest("#refresh")) return refresh();
  if (e.target.closest("#setup")) return td.setup.edit();
  if (e.target.closest("#review")) return reviewPr(p);
  if (e.target.closest("#open")) return openPr(p);
  const row = e.target.closest("[data-i]");
  if (row) move(Number(row.dataset.i));
});
document.addEventListener("dblclick", (e) => e.target.closest("[data-i]") && reviewPr(data?.prs[cursor]));

// Fetch now, then every few minutes while the tab is shown
refresh();
setInterval(() => visible && refresh(), Math.max(1, setup.refresh_minutes) * 60_000);
