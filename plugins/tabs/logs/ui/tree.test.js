import { test } from "node:test";
import assert from "node:assert/strict";
import { age, ancestors, blockKey, findLine, formatLine, lineOf, parentIndex, rows } from "./tree.js";
const line = (level, message) => ({ level, time: "2026-07-31 10:00:01,020", message, data: {} });
const lines = [line("INFO", "start"), line("DEBUG", "a"), line("ERROR", "boom"), line("INFO", "b"), line("ERROR", "end")];
const step = { type: "block", kind: "index", name: "Given x", first_line: 1, last_line: 2, has_error: true,
    children: [{ type: "line", line: 1 }, { type: "line", line: 2 }] };
const scenario = { type: "block", kind: "bookmark", name: "Login", first_line: 0, last_line: 3, has_error: true,
    children: [{ type: "line", line: 0 }, step, { type: "line", line: 3 }] };
const outline = [scenario, { type: "line", line: 4 }];
test("closed blocks hide their contents", () => {
    const r = rows(outline, lines, new Set(), new Set());
    assert.deepEqual(r.map((x) => x.key), ["bookmark:0", "line:4"]);
});
test("open blocks show them, indented; hidden levels are left out", () => {
    const open = new Set(["bookmark:0", "index:1"]);
    const r = rows(outline, lines, open, new Set());
    assert.deepEqual(r.map((x) => [x.key, x.depth]), [
        ["bookmark:0", 0], ["line:0", 1], ["index:1", 1], ["line:1", 2], ["line:2", 2], ["line:3", 1], ["line:4", 0],
    ]);
    const noDebug = rows(outline, lines, open, new Set(["DEBUG"]));
    assert.ok(!noDebug.some((x) => x.key === "line:1"));
    assert.ok(noDebug.some((x) => x.key === "index:1"), "blocks stay");
});
test("parents, ancestors and the line a row stands for", () => {
    const r = rows(outline, lines, new Set(["bookmark:0", "index:1"]), new Set());
    assert.equal(parentIndex(r, 4), 2, "line 2's parent is the step");
    assert.equal(parentIndex(r, 2), 0);
    assert.equal(parentIndex(r, 0), null);
    assert.deepEqual(ancestors(outline).get(2), ["bookmark:0", "index:1"]);
    assert.deepEqual(ancestors(outline).get(4), []);
    assert.equal(lineOf(r[2]), 1);
    assert.equal(blockKey(step), "index:1");
});
test("finding errors wraps around and skips hidden levels", () => {
    const isError = (l) => l.level === "ERROR";
    assert.equal(findLine(lines, 0, 1, new Set(), isError), 2);
    assert.equal(findLine(lines, 2, 1, new Set(), isError), 4);
    assert.equal(findLine(lines, 4, 1, new Set(), isError), 2, "wraps");
    assert.equal(findLine(lines, 2, -1, new Set(), isError), 4, "backwards wraps too");
    assert.equal(findLine(lines, 0, 1, new Set(["ERROR"]), isError), null);
});
test("line format and ages", () => {
    assert.equal(formatLine(line("ERROR", "a\nb")), "10:00:01 │ ERROR   │ a b");
    assert.equal(formatLine({ level: "UNKNOWN", time: "", message: "x", data: {} }), "x");
    assert.equal(age(1000, 1030), "just now");
    assert.equal(age(0, 7200), "2h ago");
});
import { copyText, jsonRows } from "./tree.js";
test("an entry as rows: top level open, deeper closed until opened", () => {
    const entry = { message: "x".repeat(300), response: { status: 200, headers: { a: "1" }, ok: true, body: null }, list: [1] };
    let r = jsonRows(entry, new Set(), new Set());
    assert.deepEqual(r.map((x) => x.path), ["message", "response", "response.status", "response.headers",
        "response.ok", "response.body", "list", "list.[0]"]);
    assert.ok(r[0].display.endsWith("…") && r[0].display.length === 201, "long strings shortened for display");
    assert.equal(r[3].display, "{1}");
    assert.equal(r[6].display, "[1]");
    r = jsonRows(entry, new Set(["response"]), new Set(["response.headers"]));
    assert.deepEqual(r.map((x) => x.path), ["message", "response", "list", "list.[0]"], "closed top level");
    r = jsonRows(entry, new Set(), new Set(["response.headers"]));
    assert.ok(r.some((x) => x.path === "response.headers.a" && x.depth === 2));
    assert.equal(copyText({ a: 1 }), '{\n  "a": 1\n}');
    assert.equal(copyText("full text"), "full text");
});

test("repeats fold when they're the same but for the time; one request's lines", async () => {
  const { rows, signature } = await import("./tree.js");
  const lines = [
    { level: "DEBUG", message: "healthcheck ok", data: { time: "1", msg: "healthcheck ok" } },
    { level: "DEBUG", message: "healthcheck ok", data: { time: "2", msg: "healthcheck ok" } },
    { level: "INFO", message: "GET /cart", data: { time: "3", msg: "GET /cart", req: "r1" } },
    { level: "INFO", message: "GET /cart", data: { time: "4", msg: "GET /cart", req: "r2" } },
  ];
  const outline = lines.map((_, i) => ({ type: "line", line: i }));
  const folded = rows(outline, lines, new Set(), new Set(), { fold: true });
  assert.deepEqual(folded.map((r) => [r.line, r.count ?? 1]), [[0, 2], [2, 1], [3, 1]], "different requests don't fold");
  assert.equal(signature(lines[0]), signature(lines[1]));
  const only = rows(outline, lines, new Set(), new Set(), { only: (l) => l.data.req === "r2" });
  assert.deepEqual(only.map((r) => r.line), [3]);
});

test("times, the timeline, fields and requests", async () => {
  const { timeMs, histogram, extraFields, requestOf } = await import("./tree.js");
  assert.equal(timeMs("2026-10-20T09:00:01.250Z"), Date.UTC(2026, 9, 20, 9, 0, 1, 250));
  assert.equal(timeMs("2026-10-20 09:00:01,5"), Date.UTC(2026, 9, 20, 9, 0, 1, 500));
  assert.equal(timeMs("09:00:01"), Date.UTC(1970, 0, 1, 9, 0, 1));
  assert.equal(timeMs("no time"), null);
  const h = histogram([{ time: "2026-10-20 09:00:00", level: "INFO" }, { time: "2026-10-20 09:00:30", level: "ERROR" }, { time: "", level: "INFO" }], 2);
  assert.deepEqual([h.bins[0].INFO, h.bins[1].ERROR, h.max], [1, 1, 1]);
  assert.equal(histogram([{ time: "", level: "INFO" }]), null);
  const fields = { message: ["msg"], level: ["level"], time: ["time"] };
  assert.deepEqual(extraFields({ time: "x", level: "info", msg: "hi", req: "r1", err: { stack: "…" }, tags: [1, 2] }, fields), [["req", "r1"], ["err", "{…}"], ["tags", "[2]"]]);
  assert.deepEqual(requestOf({ req: "r9" }), ["req", "r9"]);
  assert.deepEqual(requestOf({ trace_id: 5 }), ["trace_id", "5"]);
  assert.equal(requestOf({ msg: "x" }), null);
});
