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
    pullRequest(number: $number) {
      body url headRefOid headRefName baseRefName
      author { login }
      labels(first: 20) { nodes { name } }
      reviewRequests(first: 20) { nodes { requestedReviewer { ... on User { login } ... on Team { name } } } }
      latestReviews(first: 20) { nodes { author { login } state } }
      commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: 50) { nodes {
        __typename ... on CheckRun { name status conclusion } ... on StatusContext { context state }
      } } } } } }
      reviewThreads(first: 100) { nodes {
        id isResolved isOutdated path line startLine diffSide
        comments(first: 50) { nodes { author { login } body createdAt } }
      } }
    }
  }
}`;

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
      ? { name: str(c, "context"), state: CHECK_STATE[str(c, "state")] ?? "pending" }
      : { name: str(c, "name"), state: str(c, "status") === "COMPLETED" ? (CHECK_STATE[str(c, "conclusion")] ?? "neutral") : "pending", detail: str(c, "status") === "COMPLETED" ? "" : str(c, "status").toLowerCase().replace("_", " ") },
  );
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
  };
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
