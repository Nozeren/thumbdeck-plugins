import { test } from "node:test";
import assert from "node:assert/strict";
import { ago, cut, groupChanges, lineKind, MAX_DIFF, parseBranch, parseBranches, parseLog, parseStatus, refNames, track } from "./git.js";

test("branch lines", () => {
  assert.deepEqual(parseBranch("## main...origin/main [ahead 2, behind 1]"), { name: "main", upstream: "origin/main", ahead: 2, behind: 1, gone: false });
  assert.equal(parseBranch("## feat...origin/feat [gone]").gone, true);
  assert.deepEqual(parseBranch("## main"), { name: "main", upstream: null, ahead: 0, behind: 0, gone: false });
  assert.equal(parseBranch("## No commits yet on main").name, "main");
  assert.equal(parseBranch("## HEAD (no branch)").name, null);
});

test("status entries", () => {
  const { branch, changes } = parseStatus("## main\0M  a.rs\0 M b rs\0R  new.rs\0old.rs\0?? dir/c.txt\0UU d.rs\0AA e.rs\0");
  assert.equal(branch.name, "main");
  assert.deepEqual(changes.map((c) => [c.path, c.from, c.staged, c.unstaged]), [
    ["a.rs", null, "M", " "],
    ["b rs", null, " ", "M"],
    ["new.rs", "old.rs", "R", " "],
    ["dir/c.txt", null, "?", "?"],
    ["d.rs", null, "U", "U"],
    ["e.rs", null, "U", "U"],
  ]);
});

test("log and branches from their record formats", () => {
  const log = parseLog("abc\x1fa\x1fMe\x1f2026-01-01T00:00:00Z\x1fFix: a | b\x1fHEAD -> main\x1e\nxyz\x1fx\x1fYou\x1f2026-01-02T00:00:00Z\x1fSecond\x1f\x1e");
  assert.deepEqual(log.map((c) => c.subject), ["Fix: a | b", "Second"]);
  const b = parseBranches("main\x1f*\x1forigin/main\x1f[ahead 1]\x1f2026-01-01T00:00:00Z\x1fSub\x1e\nold\x1f \x1f\x1f\x1f2026-01-01T00:00:00Z\x1fOld\x1e");
  assert.deepEqual(b.map((x) => [x.name, x.current, x.upstream]), [["main", true, "origin/main"], ["old", false, null]]);
});

test("files are grouped: staged, changed (conflicts first), untracked", () => {
  const c = (path, staged, unstaged) => ({ path, from: null, staged, unstaged });
  const rows = groupChanges([c("a", "M", "M"), c("b", " ", "M"), c("u", "U", "U"), c("n", "?", "?"), c("s", "A", " ")]);
  assert.deepEqual(rows.map((r) => `${r.group}:${r.change.path}:${r.state}`), [
    "staged:a:M", "staged:s:A", "changes:u:U", "changes:a:M", "changes:b:M", "untracked:n:?",
  ]);
});

test("diff lines", () => {
  assert.equal(lineKind("diff --git a/x b/x"), "meta");
  assert.equal(lineKind("+++ b/x"), "meta");
  assert.equal(lineKind("@@ -1,2 +1,3 @@ fn main"), "hunk");
  assert.equal(lineKind("+new"), "add");
  assert.equal(lineKind("-old"), "del");
  assert.equal(lineKind(" same"), "text");
});

test("small helpers", () => {
  assert.equal(track(2, 1), "↑2 ↓1");
  assert.equal(track(0, 0), "");
  assert.deepEqual(refNames("HEAD -> main, origin/main, tag: v1"), ["main", "origin/main", "tag: v1"]);
  assert.deepEqual(refNames(""), []);
  const now = Date.parse("2026-01-01T12:00:00Z");
  assert.equal(ago("2026-01-01T11:55:00Z", now), "5m ago");
  assert.equal(ago("nonsense", now), "");
  assert.ok(cut("x".repeat(MAX_DIFF + 5)).endsWith("too long to show)"));
});
