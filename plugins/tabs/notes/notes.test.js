import { test } from "node:test";
import assert from "node:assert/strict";
import { lineAt, openItems, openList, toggle } from "./notes.js";

const text = "# Shop\n- [ ] fix login\n- [x] ship it\n  * [ ] nested\nplain";

test("open checklist items", () => {
  assert.equal(openItems(text), 2);
  assert.equal(openItems(""), 0);
});

test("the open items' text", () => {
  assert.deepEqual(openList(text), ["fix login", "nested"]);
  assert.deepEqual(openList("- [ ]\n"), [""]);
  assert.deepEqual(openList(""), []);
});

test("ticking and unticking", () => {
  assert.equal(toggle(text, 1).split("\n")[1], "- [x] fix login");
  assert.equal(toggle(text, 2).split("\n")[2], "- [ ] ship it");
  assert.equal(toggle(text, 3).split("\n")[3], "  * [x] nested");
  assert.equal(toggle(text, 0), text, "not an item");
  assert.equal(toggle(text, 99), text);
});

test("the line of an offset", () => {
  assert.equal(lineAt(text, 0), 0);
  assert.equal(lineAt(text, 7), 1);
  assert.equal(lineAt(text, text.length), 4);
});
