import { test } from "node:test";
import assert from "node:assert/strict";
import { add, age, isSecret, kind, line, MAX_SIZE, shown } from "./clip.js";

test("adding: newest first, no doubles, pinned ones stay", () => {
  let items = [];
  items = add(items, "one", 1);
  items = add(items, "two", 2);
  items = add(items, "one", 3);
  assert.deepEqual(items.map((i) => i.text), ["one", "two"]);
  assert.equal(items[0].at, 3);
  items[1].pinned = true;
  items = add(items, "three", 4, 1);
  assert.deepEqual(items.map((i) => i.text), ["three", "two"], "one dropped off; two is pinned");
  items = add(items, "two", 5, 1);
  assert.equal(items.find((i) => i.text === "two").pinned, true, "copied again: still pinned");
  assert.equal(add(items, "   ", 6), items, "blank: ignored");
  assert.equal(add(items, "x".repeat(MAX_SIZE + 1), 6), items, "too big: ignored");
});

test("shown: pinned first, then newest; filtered by words", () => {
  const items = [
    { text: "git push origin main", at: 1, pinned: false },
    { text: "https://staging.shop.test/admin", at: 3, pinned: false },
    { text: "SELECT * FROM orders", at: 2, pinned: true },
  ];
  assert.deepEqual(shown(items).map((i) => i.at), [2, 3, 1]);
  assert.deepEqual(shown(items, "ORIGIN git").map((i) => i.at), [1]);
  assert.deepEqual(shown(items, "nothing"), []);
});

test("one line, a kind, an age", () => {
  assert.equal(line("  a\n  b  \n c"), "a ⏎ b ⏎ c");
  assert.equal(line("abcdef", 4), "abc…");
  assert.equal(kind("https://example.com/a?b=1"), "url");
  assert.equal(kind('{"a": 1}'), "json");
  assert.equal(kind("{not json"), "");
  assert.equal(kind("me@example.com"), "email");
  assert.equal(kind("#ff8800"), "color");
  assert.equal(kind("0f873f19-1e0c-44e1-a546-5ca13c7c2446"), "uuid");
  assert.equal(kind("42.5"), "number");
  assert.equal(kind("~/dev/shop/.env"), "path");
  assert.equal(kind("eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiI0MiJ9.c2ln"), "jwt");
  assert.equal(kind("a\nb\nc"), "3 lines");
  assert.equal(age(0, 30_000), "now");
  assert.equal(age(0, 3 * 3600_000), "3h");
});

test("password managers' copies", () => {
  assert.equal(isSecret(["text/plain", "x-kde-passwordManagerHint"]), true);
  assert.equal(isSecret(["text/plain", "UTF8_STRING"]), false);
});
