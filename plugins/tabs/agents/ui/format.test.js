import { test } from "node:test";
import assert from "node:assert/strict";
import { ago, count, money, shortModel, tokensLine, toolSummary, uses } from "./format.js";


test("counts, money, models", () => {
  assert.equal(count(999), "999");
  assert.equal(count(1234), "1.2k");
  assert.equal(count(381363), "381k");
  assert.equal(count(130264470), "130M");
  assert.equal(count(2000), "2k");
  assert.equal(tokensLine({ input: 10, output: 2500, cache_read: 1000, cache_write: 0 }), "1k in · 2.5k out");
  assert.equal(money(5.1952), "$5.20");
  assert.equal(money(0.001), "<$0.01");
  assert.equal(money(null), "");
  assert.equal(shortModel("claude-opus-5-5"), "opus 5.5");
  assert.equal(shortModel("claude-haiku-4-5-20251001"), "haiku 4.5");
  assert.equal(shortModel("claude-sonnet-5"), "sonnet 5");
  assert.equal(shortModel("gpt-x"), "gpt-x");
  assert.equal(shortModel(null), "");
});

test("ages", () => {
  const now = Date.parse("2026-09-26T12:00:00Z");
  assert.equal(ago("2026-09-26T11:59:30Z", now), "just now");
  assert.equal(ago("2026-09-26T11:55:00Z", now), "5m ago");
  assert.equal(ago("2026-09-24T12:00:00Z", now), "2d ago");
  assert.equal(ago("nope", now), "");
});

test("tool summaries", () => {
  const t = (name, input) => ({ kind: "tool", time: "", id: "", name, input, result: null, agent: null });
  assert.equal(toolSummary(t("Bash", { command: "npm   test\n--watch", description: "Run tests" })), "npm test --watch");
  assert.equal(toolSummary(t("Read", { file_path: "/a/b.rs" })), "/a/b.rs");
  assert.equal(toolSummary(t("Agent", { subagent_type: "counter", description: "Count files", prompt: "..." })), "counter: Count files");
  assert.equal(toolSummary(t("Mystery", { thing: "x" })), "x");
  assert.equal(toolSummary(t("Nothing", null)), "");
});

test("uses per agent type", () => {
  const s = (types) => ({ subagents: types.map((agent_type) => ({ agent_type })) });
  const u = uses([s(["Explore", "counter"]), s(["Explore"])]);
  assert.equal(u.get("Explore"), 2);
  assert.equal(u.get("counter"), 1);
});
