// The Pull requests tab's logic: pure functions, tested with `node --test` (prs.test.js).

export const QUERY = `query($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
    pullRequests(first: 50, states: OPEN, orderBy: {field: UPDATED_AT, direction: DESC}) {
      nodes {
        number title isDraft url updatedAt mergeable
        author { login }
        labels(first: 10) { nodes { name } }
        commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
        reviewRequests(first: 10) { nodes { requestedReviewer { ... on User { login } ... on Team { name } } } }
        reviews(last: 50) { nodes { author { login } state } }
        comments(last: 1) { totalCount nodes { author { login } updatedAt } }
      }
    }
  }
}`;

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

/** The PRs that concern `user`, in the order to deal with them (newest first within each) */
export function sortPrs(response, notifications, user, setup) {
  const short = (login) => (setup.trim_suffix && login.endsWith(setup.trim_suffix) ? login.slice(0, -setup.trim_suffix.length) : login);
  // PR web URL -> unread notification id
  const unread = new Map(
    (Array.isArray(notifications) ? notifications : [])
      .filter((n) => str(n, "subject.type") === "PullRequest")
      .map((n) => [str(n, "subject.url").replace("https://api.github.com/repos/", "https://github.com/").replace("/pulls/", "/pull/"), str(n, "id")]),
  );
  const out = [];
  for (const pr of nodes(response, "data.repository.pullRequests.nodes")) {
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
      number: Number(pr.number) || 0,
      title: str(pr, "title"),
      url,
      author: author ? short(author) : "unknown",
      updated: str(pr, "updatedAt"),
      draft: pr.isDraft === true,
      checks: str(pr, "commits.nodes.0.commit.statusCheckRollup.state"),
      mergeable: str(pr, "mergeable"),
      labels: nodes(pr, "labels.nodes").map((l) => str(l, "name")),
      comments: Number(at(pr, "comments.totalCount")) || 0,
      lastComment: last ? { author: short(str(last, "author.login")), updated: str(last, "updatedAt") } : null,
      reviewers,
      notification: unread.get(url) ?? null,
    });
  }
  // Stable: newest first stays within each group
  return out.sort((a, b) => ORDER[a.category] - ORDER[b.category]);
}

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
