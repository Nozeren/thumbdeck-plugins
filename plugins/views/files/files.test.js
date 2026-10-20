import { test } from "node:test";
import assert from "node:assert/strict";
import { bulkPlan, fuzzy, human, kindOf, parseGitStatus, quote, score, sortEntries, statusFor, tilde, uniqueName } from "./files.js";

test("kinds of files", () => {
  assert.equal(kindOf("login.spec.ts"), "code");
  assert.equal(kindOf("README.md"), "md");
  assert.equal(kindOf("Screenshot 2026.PNG"), "image");
  assert.equal(kindOf("backup.tar.gz"), "zip");
  assert.equal(kindOf("Dockerfile"), "code");
  assert.equal(kindOf(".env.local"), "code");
  assert.equal(kindOf("ubuntu.iso"), "file");
  assert.equal(kindOf("notes"), "file");
});

test("sorting keeps folders first", () => {
  const e = [
    { name: "b.txt", dir: false, size: 10, mtime: 3 },
    { name: "src", dir: true, size: 0, mtime: 1 },
    { name: "a10.txt", dir: false, size: 99, mtime: 1 },
    { name: "a9.txt", dir: false, size: 5, mtime: 2 },
  ];
  assert.deepEqual(sortEntries(e).map((x) => x.name), ["src", "a9.txt", "a10.txt", "b.txt"]);
  assert.deepEqual(sortEntries(e, "size").map((x) => x.name), ["src", "a10.txt", "b.txt", "a9.txt"]);
  assert.deepEqual(sortEntries(e, "date").map((x) => x.name), ["src", "b.txt", "a9.txt", "a10.txt"]);
});

test("fuzzy matching and ranking", () => {
  assert.deepEqual(fuzzy("lgn", "login.spec.ts"), [0, 2, 4]);
  assert.equal(fuzzy("xyz", "login"), null);
  const paths = ["tests/pages/login.page.ts", "tests/login.spec.ts", "docs/blog/long-night.md"];
  const ranked = paths.filter((p) => score("login", p) >= 0).sort((a, b) => score("login", b) - score("login", a));
  assert.deepEqual(ranked, ["tests/login.spec.ts", "tests/pages/login.page.ts"]);
});

test("git status", () => {
  const out = [" M tests/login.spec.ts", "?? tests/cart.spec.ts", "R  pages/new.ts", "pages/old.ts", "!! test-results/", "A  README.md", ""].join("\0");
  const s = parseGitStatus(out);
  assert.deepEqual(s, { "tests/login.spec.ts": "M", "tests/cart.spec.ts": "U", "pages/new.ts": "R", "test-results": "I", "README.md": "A" });
  assert.deepEqual(statusFor(["tests", "pages", "test-results", "README.md", "package.json"], "", s), { tests: "•", pages: "•", "test-results": "I", "README.md": "A" });
  assert.deepEqual(statusFor(["login.spec.ts", "cart.spec.ts", "search.spec.ts"], "tests", s), { "login.spec.ts": "M", "cart.spec.ts": "U" });
  assert.deepEqual(statusFor(["junit.xml"], "test-results", s), { "junit.xml": "I" });
});

test("names for copies", () => {
  assert.equal(uniqueName("a.pdf", ["b.pdf"]), "a.pdf");
  assert.equal(uniqueName("a.pdf", ["a.pdf", "a (2).pdf"]), "a (3).pdf");
  assert.equal(uniqueName("backup.tar.gz", ["backup.tar.gz"]), "backup (2).tar.gz");
  assert.equal(uniqueName("src", ["src"]), "src (2)");
});

test("bulk renames", () => {
  const names = ["IMG_1.jpg", "IMG_2.jpg", "notes.txt"];
  assert.deepEqual(bulkPlan(names, "beach-1.jpg\nbeach-2.jpg\nnotes.txt\n"), { changes: [["IMG_1.jpg", "beach-1.jpg"], ["IMG_2.jpg", "beach-2.jpg"]], problem: "" });
  assert.match(bulkPlan(names, "a\nb").problem, /2 lines for 3/);
  assert.match(bulkPlan(names, "a\na\nc").problem, /twice/);
  assert.match(bulkPlan(names, "a\n\nc").problem, /empty/);
  assert.match(bulkPlan(names, "a/b\nb\nc").problem, /a \//);
  assert.match(bulkPlan(names, "other.txt\nb\nc", [...names, "other.txt"]).problem, /already/);
  assert.deepEqual(bulkPlan(["a", "b"], "b\na").changes, [["a", "b"], ["b", "a"]], "a swap is fine");
});

test("sizes, paths, quoting", () => {
  assert.equal(human(512), "512 B");
  assert.equal(human(1536), "1.5 KB");
  assert.equal(human(5.8 * 1024 ** 3), "5.8 GB");
  assert.equal(tilde("/home/a/dev/x", "/home/a"), "~/dev/x");
  assert.equal(tilde("/home/ab", "/home/a"), "/home/ab");
  assert.equal(quote("plain-name.txt"), "plain-name.txt");
  assert.equal(quote("it's here.txt"), "'it'\\''s here.txt'");
});
