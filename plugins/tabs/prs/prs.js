// The Pull requests view's logic: pure functions, tested with `node --test` (prs.test.js).

// The fields of a PR the list needs
const PR_FIELDS = `
  number title isDraft url updatedAt mergeable headRefName baseRefName
  repository { nameWithOwner }
  author { login }
  labels(first: 10) { nodes { name } }
  commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
  reviewRequests(first: 10) { nodes { requestedReviewer { ... on User { login } ... on Team { name } } } }
  reviews(last: 50) { nodes { author { login } state } }
  comments(last: 1) { totalCount nodes { author { login } updatedAt } }`;

/** The open PRs that concern you, in every repo you can see: three searches at once, since
 *  `involves:` leaves out the PRs you were only asked to review */
export const SEARCH_QUERY = `query($a: String!, $b: String!, $c: String!) {
  a: search(query: $a, type: ISSUE, first: 100) { nodes { ... on PullRequest { ${PR_FIELDS} } } }
  b: search(query: $b, type: ISSUE, first: 100) { nodes { ... on PullRequest { ${PR_FIELDS} } } }
  c: search(query: $c, type: ISSUE, first: 100) { nodes { ... on PullRequest { ${PR_FIELDS} } } }
}`;

/**
 * The three searches, limited by the Repos setting: empty for every repo you're in; otherwise
 * owners ("acme") and repos ("acme/app"), separated by spaces or commas.
 */
export function searches(repos) {
  const limit = String(repos ?? "")
    .split(/[\s,]+/)
    .filter(Boolean)
    .map((r) => (r.includes("/") ? `repo:${r}` : `user:${r}`))
    .join(" ");
  const base = `is:pr is:open archived:false${limit ? ` ${limit}` : ""}`;
  return { a: `${base} involves:@me`, b: `${base} review-requested:@me`, c: `${base} reviewed-by:@me` };
}

/** One PR's details for the review page: description, checks, review threads */
export const PR_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    mergeCommitAllowed squashMergeAllowed rebaseMergeAllowed deleteBranchOnMerge viewerDefaultMergeMethod
    pullRequest(number: $number) {
      id title body url isDraft headRefOid headRefName baseRefName mergeStateStatus reviewDecision viewerCanUpdate
      headRepository { nameWithOwner }
      author { login }
      suggestedReviewers { reviewer { login name } }
      labels(first: 20) { nodes { name } }
      reviewRequests(first: 20) { nodes { requestedReviewer { ... on User { login } ... on Team { name } } } }
      latestReviews(first: 20) { nodes { author { login } state } }
      commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: 50) { nodes {
        __typename ... on CheckRun { name status conclusion databaseId detailsUrl checkSuite { workflowRun { databaseId } } }
        ... on StatusContext { context state targetUrl }
      } } } } } }
      reviewThreads(first: 100) { nodes {
        id isResolved isOutdated path line startLine diffSide
        comments(first: 50) { nodes { author { login } body createdAt } }
      } }
    }
  }
}`;

export const PEOPLE_QUERY = `query($owner: String!, $name: String!, $q: String!) {
  repository(owner: $owner, name: $name) { assignableUsers(first: 20, query: $q) { nodes { login name } } }
}`;
export const READY_MUTATION = `mutation($id: ID!) { markPullRequestReadyForReview(input: { pullRequestId: $id }) { pullRequest { isDraft } } }`;
export const DRAFT_MUTATION = `mutation($id: ID!) { convertPullRequestToDraft(input: { pullRequestId: $id }) { pullRequest { isDraft } } }`;

export const REPLY_MUTATION = `mutation($thread: ID!, $body: String!) {
  addPullRequestReviewThreadReply(input: { pullRequestReviewThreadId: $thread, body: $body }) { comment { id } }
}`;
export const RESOLVE_MUTATION = `mutation($thread: ID!) { resolveReviewThread(input: { threadId: $thread }) { thread { id } } }`;
export const UNRESOLVE_MUTATION = `mutation($thread: ID!) { unresolveReviewThread(input: { threadId: $thread }) { thread { id } } }`;

/** "owner/name" from a GitHub remote URL (https, ssh or scp-like), if it's one */
export function repoFromUrl(url) {
  const at = url.trim().indexOf("github.com");
  if (at < 0) return null;
  const rest = url.trim().slice(at + "github.com".length).replace(/^[:/]+/, "").replace(/\/+$/, "").replace(/\.git$/, "");
  const parts = rest.split("/");
  return parts.length === 2 && parts[0] && parts[1] ? `${parts[0]}/${parts[1]}` : null;
}

const ORDER = { "re-review": 0, review: 1, reviewed: 2, mine: 3 };
const at = (v, path) => path.split(".").reduce((x, k) => (x == null ? undefined : x[k]), v);
const str = (v, path) => (typeof at(v, path) === "string" ? at(v, path) : "");
const nodes = (v, path) => (Array.isArray(at(v, path)) ? at(v, path) : []);

/** The PR nodes of an answer: the three searches, each PR once (or one repo's, the old way) */
export function prNodes(response) {
  if (at(response, "data.repository")) return nodes(response, "data.repository.pullRequests.nodes");
  const seen = new Set();
  return ["a", "b", "c"].flatMap((k) => nodes(response, `data.${k}.nodes`)).filter((pr) => {
    const url = str(pr, "url");
    if (!url || seen.has(url)) return false;
    seen.add(url);
    return true;
  });
}

/** A user name without the setup's suffix ("ann_corp" -> "ann") */
const shortener = (setup) => (login) => (setup.trim_suffix && login.endsWith(setup.trim_suffix) ? login.slice(0, -setup.trim_suffix.length) : login);

/** The PRs that concern `user`, in the order to deal with them (newest first within each) */
export function sortPrs(response, notifications, user, setup, fallbackRepo = "") {
  const short = shortener(setup);
  // PR web URL -> unread notification id
  const unread = new Map(
    (Array.isArray(notifications) ? notifications : [])
      .filter((n) => str(n, "subject.type") === "PullRequest")
      .map((n) => [str(n, "subject.url").replace("https://api.github.com/repos/", "https://github.com/").replace("/pulls/", "/pull/"), str(n, "id")]),
  );
  const out = [];
  for (const pr of prNodes(response)) {
    const author = str(pr, "author.login");
    const requested = (login) => nodes(pr, "reviewRequests.nodes").some((r) => str(r, "requestedReviewer.login") === login);
    const reviewed = nodes(pr, "reviews.nodes").some((r) => str(r, "author.login") === user);
    const category = author === user ? "mine" : requested(user) && reviewed ? "re-review" : requested(user) ? "review" : reviewed ? "reviewed" : null;
    if (!category) continue;

    // Each reviewer's latest review, then those asked who haven't reviewed
    let reviewers = [];
    for (const r of nodes(pr, "reviews.nodes")) {
      const login = str(r, "author.login");
      if (!login || setup.bots.includes(login)) continue;
      const found = reviewers.find((x) => x.name === login);
      if (found) found.state = str(r, "state");
      else reviewers.push({ name: login, state: str(r, "state") });
    }
    for (const r of nodes(pr, "reviewRequests.nodes")) {
      const who = str(r, "requestedReviewer.login") || str(r, "requestedReviewer.name");
      if (who && !setup.bots.includes(who)) {
        reviewers = reviewers.filter((x) => x.name !== who); // asked again: pending
        reviewers.push({ name: who, state: "PENDING" });
      }
    }
    reviewers = reviewers.map((r) => ({ ...r, name: short(r.name) }));

    const url = str(pr, "url");
    const last = nodes(pr, "comments.nodes")[0];
    out.push({
      category,
      repo: str(pr, "repository.nameWithOwner") || repoFromUrl(url.replace(/\/pull\/\d+$/, "")) || fallbackRepo,
      number: Number(pr.number) || 0,
      title: str(pr, "title"),
      url,
      author: author ? short(author) : "unknown",
      updated: str(pr, "updatedAt"),
      draft: pr.isDraft === true,
      head: str(pr, "headRefName"),
      base: str(pr, "baseRefName"),
      checks: str(pr, "commits.nodes.0.commit.statusCheckRollup.state"),
      mergeable: str(pr, "mergeable"),
      labels: nodes(pr, "labels.nodes").map((l) => str(l, "name")),
      comments: Number(at(pr, "comments.totalCount")) || 0,
      lastComment: last ? { author: short(str(last, "author.login")), updated: str(last, "updatedAt") } : null,
      reviewers,
      notification: unread.get(url) ?? null,
    });
  }
  // Newest first, then by group (the sort is stable)
  return out.sort((a, b) => b.updated.localeCompare(a.updated)).sort((a, b) => ORDER[a.category] - ORDER[b.category]);
}

const CHECK_STATE = { SUCCESS: "success", NEUTRAL: "neutral", SKIPPED: "neutral", FAILURE: "failure", ERROR: "failure", TIMED_OUT: "failure", CANCELLED: "failure", ACTION_REQUIRED: "failure", STARTUP_FAILURE: "failure" };
const REVIEW_STATE = { APPROVED: "approved", CHANGES_REQUESTED: "changes requested", COMMENTED: "commented", DISMISSED: "dismissed", PENDING: "asked" };

/** About a PR, for the review page's pane: its description, checks, reviewers and labels */
export function aboutFrom(response, setup) {
  const short = shortener(setup);
  const pr = at(response, "data.repository.pullRequest") ?? {};
  const checks = nodes(pr, "commits.nodes.0.commit.statusCheckRollup.contexts.nodes").map((c) =>
    c.__typename === "StatusContext"
      ? { name: str(c, "context"), state: CHECK_STATE[str(c, "state")] ?? "pending", ...(str(c, "targetUrl") ? { url: str(c, "targetUrl") } : {}) }
      : {
        name: str(c, "name"), state: str(c, "status") === "COMPLETED" ? (CHECK_STATE[str(c, "conclusion")] ?? "neutral") : "pending", detail: str(c, "status") === "COMPLETED" ? "" : str(c, "status").toLowerCase().replace("_", " "),
        // A GitHub Actions job: its id (its steps and log), its run's (re-running it)
        ...(c.databaseId ? { job: Number(c.databaseId) } : {}), ...(at(c, "checkSuite.workflowRun.databaseId") ? { run: Number(at(c, "checkSuite.workflowRun.databaseId")) } : {}),
        ...(str(c, "detailsUrl") ? { url: str(c, "detailsUrl") } : {}),
      },
  );
  const repo = at(response, "data.repository") ?? {};
  const head = str(pr, "headRepository.nameWithOwner");
  const reviewers = nodes(pr, "latestReviews.nodes")
    .filter((r) => !setup.bots.includes(str(r, "author.login")))
    .map((r) => ({ name: short(str(r, "author.login")), state: REVIEW_STATE[str(r, "state")] ?? str(r, "state").toLowerCase() }));
  for (const r of nodes(pr, "reviewRequests.nodes")) {
    const who = str(r, "requestedReviewer.login") || str(r, "requestedReviewer.name");
    if (who && !setup.bots.includes(who)) reviewers.push({ name: short(who), state: "asked" });
  }
  return {
    description: str(pr, "body"),
    author: short(str(pr, "author.login")),
    head: str(pr, "headRefName"),
    base: str(pr, "baseRefName"),
    url: str(pr, "url"),
    checks,
    reviewers,
    labels: nodes(pr, "labels.nodes").map((l) => str(l, "name")),
    // For changing it: its id, title, merging (the repo's methods), reviewers to ask
    id: str(pr, "id"),
    title: str(pr, "title"),
    draft: pr.isDraft === true,
    headOid: str(pr, "headRefOid"),
    canUpdate: pr.viewerCanUpdate !== false,
    merge: {
      state: str(pr, "mergeStateStatus"), decision: str(pr, "reviewDecision"), methods: mergeMethods(repo),
      autoDelete: repo.deleteBranchOnMerge === true, fork: !!head && !!str(pr, "url") && !str(pr, "url").includes(`github.com/${head}/pull/`),
    },
    suggested: nodes(pr, "suggestedReviewers").map((r) => str(r, "reviewer.login")).filter((l) => l && !setup.bots.includes(l)),
  };
}

// Merging: the methods the repo allows, the default (the one you used last) first
const METHODS = [["squash", "squashMergeAllowed", "Squash and merge"], ["merge", "mergeCommitAllowed", "Create a merge commit"], ["rebase", "rebaseMergeAllowed", "Rebase and merge"]];
/** [{ value: "squash" | "merge" | "rebase", label }] (unknown settings: all three) */
export function mergeMethods(repo) {
  const known = METHODS.some(([, k]) => typeof repo?.[k] === "boolean");
  const allowed = METHODS.filter(([, k]) => !known || repo[k] === true).map(([value, , label]) => ({ value, label }));
  const first = String(repo?.viewerDefaultMergeMethod ?? "").toLowerCase();
  return [...allowed.filter((m) => m.value === first), ...allowed.filter((m) => m.value !== first)];
}

/** Why GitHub won't merge it now, in words ("": it will; warn: it will, but…) */
export function mergeBlocker(m, draft = false) {
  if (draft) return { why: "it's a draft: Space d marks it ready for review first" };
  const decision = { CHANGES_REQUESTED: "changes were requested", REVIEW_REQUIRED: "it needs an approving review" }[m?.decision];
  switch (m?.state) {
    case "CLEAN": case "HAS_HOOKS": return { why: "" };
    case "UNSTABLE": return { why: "", warn: "some checks that aren't required failed" };
    case "BEHIND": return { why: "it's behind its base branch: update its branch first" };
    case "DIRTY": return { why: "it has merge conflicts" };
    case "DRAFT": return { why: "it's a draft: Space d marks it ready for review first" };
    case "BLOCKED": return { why: decision ?? "required checks haven't passed, or its branch rules don't allow it yet" };
    case "UNKNOWN": case "": case undefined: return { why: "", warn: "GitHub hasn't worked out yet whether it can be merged" };
    default: return { why: "", warn: m.state.toLowerCase() };
  }
}

// Failed checks (GitHub Actions jobs): which step failed, and the end of its log
/** The first failed step of a job (repos/…/actions/jobs/{id}): its name, or "" */
export const failedStep = (job) => (job?.steps ?? []).find((s) => ["failure", "timed_out", "cancelled"].includes(s.conclusion))?.name ?? "";

/** The end of a job's log: the lines up to its last error (the post steps after it left out),
 *  without their timestamps; at most `max` lines */
export function logTail(log, max = 30) {
  const lines = String(log ?? "").replace(/\r/g, "").split("\n").map((l) => l.replace(/^\d{4}-\d\d-\d\dT[\d:.]+Z ?/, "").replace(/\x1b\[[\d;]*m/g, ""));
  let end = lines.length;
  for (let i = lines.length - 1; i >= 0; i--) if (lines[i].includes("##[error]")) { end = i + 1; break; }
  while (end > 0 && !lines[end - 1].trim()) end--;
  return lines.slice(Math.max(0, end - max), end).map((l) => l.replace(/^##\[(error|warning|group|endgroup|debug)\]/, (m, k) => (k === "error" ? "Error: " : k === "warning" ? "Warning: " : k === "group" ? "▸ " : ""))).join("\n");
}

// Notifications (the backend): what changed since the last look, told once
const FAILED = new Set(["FAILURE", "ERROR"]);
/** What the notifications compare: url -> what matters of each PR */
export const snapshot = (prs) => Object.fromEntries(prs.map((p) => [p.url, {
  category: p.category, checks: p.checks, reviews: Object.fromEntries(p.reviewers.map((r) => [r.name, r.state])),
}]));

/** What changed since the last look (before null: the first, nothing is news): [{ kind: review |
 *  approved | changes | checks, pr, by }] */
export function prEvents(before, prs) {
  if (!before) return [];
  const out = [];
  const asked = (c) => c === "review" || c === "re-review";
  for (const p of prs) {
    const was = before[p.url];
    if (asked(p.category) && !asked(was?.category)) out.push({ kind: "review", pr: p });
    if (p.category !== "mine" || !was) continue;
    for (const r of p.reviewers) {
      const prev = was.reviews?.[r.name];
      if (r.state === "APPROVED" && prev !== "APPROVED") out.push({ kind: "approved", pr: p, by: r.name });
      if (r.state === "CHANGES_REQUESTED" && prev !== "CHANGES_REQUESTED") out.push({ kind: "changes", pr: p, by: r.name });
    }
    if (FAILED.has(p.checks) && !FAILED.has(was.checks)) out.push({ kind: "checks", pr: p });
  }
  return out;
}

/** The events as notifications ([title, body]), as the settings want them (more than four: one) */
export function notices(events, s = {}) {
  const on = { review: s.notify_review !== false, approved: s.notify_verdicts !== false, changes: s.notify_verdicts !== false, checks: s.notify_checks !== false };
  const said = events.filter((e) => on[e.kind]).map(({ kind, pr: p, by }) => {
    const pr = `${p.repo} #${p.number}`;
    const title = { review: `Review asked: ${pr}`, approved: `@${by} approved ${pr}`, changes: `@${by} requested changes on ${pr}`, checks: `Checks failed on ${pr}` }[kind];
    return [title, `${p.title}${kind === "review" && p.author !== "unknown" ? ` (@${p.author})` : ""}`];
  });
  return said.length > 4 ? [[`${said.length} changes on your pull requests`, said.map(([t]) => t).join(" · ")]] : said;
}

/** People to ask for a review (repository.assignableUsers): [{ value: login, label, note }] */
export const peopleFrom = (response) => nodes(response, "data.repository.assignableUsers.nodes")
  .map((u) => ({ value: str(u, "login"), label: str(u, "login"), note: str(u, "name") })).filter((u) => u.value);

/** Who to ask, typed: logins and teams (org/team), separated by spaces or commas */
export function reviewersFrom(typed) {
  const reviewers = [];
  const teams = [];
  for (const w of String(typed ?? "").split(/[\s,]+/).map((x) => x.replace(/^@/, "")).filter(Boolean)) {
    if (w.includes("/")) teams.push(w.split("/").pop());
    else reviewers.push(w);
  }
  return { reviewers, team_reviewers: teams };
}

/** The review threads of a PR, as the review page takes them (outdated ones: line null) */
export function threadsFrom(response, setup) {
  const short = shortener(setup);
  return nodes(response, "data.repository.pullRequest.reviewThreads.nodes").map((t) => ({
    id: str(t, "id"),
    path: str(t, "path"),
    line: t.isOutdated || t.line == null ? null : Number(t.line),
    startLine: t.startLine == null ? null : Number(t.startLine),
    side: str(t, "diffSide") === "LEFT" ? "LEFT" : "RIGHT",
    resolved: t.isResolved === true,
    comments: nodes(t, "comments.nodes").map((c) => ({ author: short(str(c, "author.login")) || "ghost", body: str(c, "body"), createdAt: str(c, "createdAt") })),
  }));
}

/** What GitHub's "create a review" takes, from what the review page sends */
export function reviewPayload({ event, body, comments }, commitId) {
  const payload = { commit_id: commitId, event, comments: comments.map((c) => ({
    path: c.path, line: c.line, side: c.side, body: c.body,
    ...(c.startLine != null && c.startLine !== c.line ? { start_line: c.startLine, start_side: c.startSide ?? c.side } : {}),
  })) };
  if (body) payload.body = body;
  if (!comments.length) delete payload.comments;
  return payload;
}

/** A file's path in a contents URL (each part escaped, the slashes kept) */
export const contentsPath = (path) => path.split("/").map(encodeURIComponent).join("/");

/** Not updated for `days` days or more */
export function isStale(updated, days, now = Date.now()) {
  const t = Date.parse(updated);
  return !Number.isNaN(t) && days > 0 && now - t >= days * 86400_000;
}

export const categoryLabel = { "re-review": "RE-REVIEW", review: "REVIEW", reviewed: "REVIEWED", mine: "MINE" };

/** A check or review state in words, with its sign */
export const checksText = (state) =>
  ({ SUCCESS: "✔ passed", FAILURE: "✘ failed", ERROR: "✘ error", PENDING: "⏳ pending", EXPECTED: "⏳ expected" })[state] ?? "no checks";

export const reviewText = (state) =>
  ({ APPROVED: "✔ approved", CHANGES_REQUESTED: "✘ changes requested", COMMENTED: "💬 commented", DISMISSED: "dismissed", PENDING: "⏳ pending" })[state] ?? state.toLowerCase();

/** "5m ago" from an ISO time */
export function ago(iso, now = Date.now()) {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const s = Math.max(0, (now - t) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

/** The filters at the top, in the order f goes through them */
export const FILTERS = [["all", "All"], ["todo", "To review"], ["mine", "Yours"], ["unread", "🔔 Unread"]];

/** The PRs a filter keeps */
export function filterPrs(prs, filter) {
  if (filter === "todo") return prs.filter((p) => p.category === "review" || p.category === "re-review");
  if (filter === "mine") return prs.filter((p) => p.category === "mine");
  if (filter === "unread") return prs.filter((p) => p.notification);
  return prs;
}

/** A PR's checks as a sign: pass, run (pending), fail, none */
export const checkSign = (state) =>
  ({ SUCCESS: "pass", FAILURE: "fail", ERROR: "fail", PENDING: "run", EXPECTED: "run" })[state] ?? "none";

/** A description (Markdown, written by anyone) as safe HTML: escaped, with `code`, **bold** and
 *  paragraphs back; cut after `max` characters */
export function descriptionHtml(text, escape, max = 700) {
  const t = String(text ?? "").replace(/\r\n/g, "\n").replace(/<!--[\s\S]*?-->/g, "").trim();
  if (!t) return "";
  const cut = t.length > max ? t.slice(0, max).replace(/\s+\S*$/, "") + " …" : t;
  return cut.split(/\n{2,}/).map((p) => `<p>${escape(p)
    .replace(/`([^`\n]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>")
    .replace(/\n/g, "<br>")}</p>`).join("");
}

/** Whether version `a` is newer than `b` ("0.8.0" vs "0.7.0"); an unknown `b` counts as old */
export function newer(a, b) {
  const parts = (v) => String(v ?? "0").split(".").map((x) => parseInt(x, 10) || 0);
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
  return false;
}
