import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { aboutFrom, checksText, contentsPath, isStale, repoFromUrl, reviewPayload, reviewText, searches, sortPrs, threadsFrom } from "./prs.js";

const testdata = (file) => JSON.parse(readFileSync(new URL(`./testdata/${file}`, import.meta.url), "utf8"));
const setup = { bots: ["copilot-pull-request-reviewer"], trim_suffix: "_corp" };

test("repos from remote URLs", () => {
  for (const url of ["git@github.com:acme/app.git", "https://github.com/acme/app", "https://github.com/acme/app.git\n", "ssh://git@github.com/acme/app.git"]) {
    assert.equal(repoFromUrl(url), "acme/app", url);
  }
  assert.equal(repoFromUrl("git@gitlab.com:acme/app.git"), null);
  assert.equal(repoFromUrl("https://github.com/acme"), null);
});

test("PRs are sorted into groups in the order to deal with them", () => {
  const prs = sortPrs(testdata("repo.json"), testdata("notifications.json"), "me_corp", setup);
  assert.deepEqual(prs.map((p) => [p.number, p.category]), [[2, "re-review"], [3, "review"], [4, "reviewed"], [1, "mine"]], "5 isn't yours");
  assert.equal(prs[0].notification, "111");
  assert.deepEqual(prs[0].reviewers, [{ name: "me", state: "PENDING" }], "asked again: pending");
  assert.equal(prs[1].author, "unknown");
  const mine = prs[3];
  assert.deepEqual([mine.author, mine.draft, mine.checks, mine.mergeable], ["me", true, "FAILURE", "CONFLICTING"]);
  assert.deepEqual(mine.labels, ["bug"]);
  assert.equal(mine.comments, 3);
  assert.equal(mine.lastComment.author, "bob");
  assert.deepEqual(mine.reviewers.map((r) => [r.name, r.state]), [["bob", "APPROVED"], ["ann", "PENDING"], ["qa-team", "PENDING"]], "latest review each, no bots");
  assert.equal(mine.notification, null);
});

test("stale after the set number of days", () => {
  const now = Date.parse("2026-09-26T12:00:00Z");
  assert.equal(isStale("2026-09-19T12:00:00Z", 7, now), true);
  assert.equal(isStale("2026-09-20T12:00:00Z", 7, now), false);
  assert.equal(isStale("2026-01-01T00:00:00Z", 0, now), false, "0: never stale");
  assert.equal(isStale("", 7, now), false);
});

test("states in words", () => {
  assert.equal(checksText("FAILURE"), "✘ failed");
  assert.equal(checksText(""), "no checks");
  assert.equal(reviewText("CHANGES_REQUESTED"), "✘ changes requested");
  assert.equal(reviewText("NEW_STATE"), "new_state");
});

test("the searches: every repo you're in, or the ones set", () => {
  assert.deepEqual(searches(""), {
    a: "is:pr is:open archived:false involves:@me",
    b: "is:pr is:open archived:false review-requested:@me",
    c: "is:pr is:open archived:false reviewed-by:@me",
  });
  assert.equal(searches("acme, other/lib").b, "is:pr is:open archived:false user:acme repo:other/lib review-requested:@me");
});

test("PRs from the three searches: each once, with its repo, in the same groups", () => {
  const prs = sortPrs(testdata("search.json"), testdata("notifications.json"), "me_corp", setup);
  assert.deepEqual(prs.map((p) => [p.number, p.category, p.repo]), [[2, "re-review", "acme/api"], [3, "review", "acme/app"], [4, "reviewed", "acme/docs"], [1, "mine", "acme/app"]]);
  assert.equal(prs[0].notification, "333", "its notification is from its own repo");
  assert.equal(prs[1].head, "feature/pr-3");
});

test("about a PR: checks, reviewers (no bots, the asked ones too), labels", () => {
  const a = aboutFrom(testdata("pr.json"), setup);
  assert.equal(a.author, "carla");
  assert.deepEqual([a.head, a.base], ["feature/discounts", "main"]);
  assert.deepEqual(a.checks.map((c) => [c.name, c.state]), [["lint", "success"], ["unit tests", "success"], ["behave", "pending"], ["deploy/preview", "success"]]);
  assert.deepEqual(a.reviewers, [{ name: "ann", state: "commented" }, { name: "bob", state: "approved" }, { name: "me", state: "asked" }]);
  assert.deepEqual(a.labels, ["feature", "checkout"]);
});

test("review threads: where they sit, outdated ones without a line", () => {
  const t = threadsFrom(testdata("pr.json"), setup);
  assert.deepEqual(t.map((x) => [x.id, x.path, x.line, x.side, x.resolved]), [
    ["T1", "src/checkout.py", 10, "RIGHT", false], ["T2", "src/discounts.py", 8, "RIGHT", false],
    ["T3", "features/checkout.feature", 6, "RIGHT", true], ["T4", "src/checkout.py", null, "RIGHT", false],
  ]);
  assert.deepEqual(t[0].comments.map((c) => c.author), ["ann", "carla"]);
});

test("a review as GitHub takes it", () => {
  const comments = [{ path: "a.py", line: 5, side: "RIGHT", body: "x" }, { path: "a.py", line: 9, side: "RIGHT", startLine: 7, startSide: "LEFT", body: "y" }];
  assert.deepEqual(reviewPayload({ event: "REQUEST_CHANGES", body: "see below", comments }, "abc"), {
    commit_id: "abc", event: "REQUEST_CHANGES", body: "see below",
    comments: [{ path: "a.py", line: 5, side: "RIGHT", body: "x" }, { path: "a.py", line: 9, side: "RIGHT", body: "y", start_line: 7, start_side: "LEFT" }],
  });
  assert.deepEqual(reviewPayload({ event: "APPROVE", body: "", comments: [] }, "abc"), { commit_id: "abc", event: "APPROVE" });
  assert.equal(contentsPath("src/a b/c#d.py"), "src/a%20b/c%23d.py");
});

test("filters and the checks' sign", async () => {
  const { filterPrs, checkSign } = await import("./prs.js");
  const prs = sortPrs(testdata("search.json"), testdata("notifications.json"), "me_corp", setup);
  assert.deepEqual(filterPrs(prs, "todo").map((p) => p.number), [2, 3]);
  assert.deepEqual(filterPrs(prs, "mine").map((p) => p.number), [1]);
  assert.deepEqual(filterPrs(prs, "unread").map((p) => p.number), [2]);
  assert.equal(filterPrs(prs, "all").length, 4);
  assert.deepEqual(["SUCCESS", "FAILURE", "ERROR", "PENDING", ""].map(checkSign), ["pass", "fail", "fail", "run", "none"]);
});

test("a description is escaped, with a little Markdown, and cut when long", async () => {
  const { descriptionHtml } = await import("./prs.js");
  const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  assert.equal(descriptionHtml("Use `x` **now**\n\n<script>alert(1)</script>", esc), "<p>Use <code>x</code> <b>now</b></p><p>&lt;script&gt;alert(1)&lt;/script&gt;</p>");
  assert.equal(descriptionHtml("<!-- template -->", esc), "");
  assert.ok(descriptionHtml("word ".repeat(400), esc, 50).endsWith(" …</p>"));
});
