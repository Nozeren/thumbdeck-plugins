import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { checksText, isStale, repoFromUrl, reviewText, sortPrs } from "./prs.js";

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
