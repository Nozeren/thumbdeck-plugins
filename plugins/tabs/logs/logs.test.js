import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { blocks, complete, dateText, epoch, formatDuration, level, list, open, outline, parse, problems, summary, timestamp, title } from "./logs.js";

/** A sample test run: JSON lines, two test scenarios */
const SAMPLE = readFileSync(new URL("./testdata/sample_run.log", import.meta.url), "utf8");

/** Sections for the sample run: they check that the section rules work as intended */
const sections = [
  { name: "scenario", kind: "bookmark", start: ["# Scenario: "], end: ["# Scenario:", "short test summary info"],
    alias: { type: "regex", value: "################ (.*?) ################" } },
  { name: "environment_setup", kind: "index", start: ["configuration file."], end: ["# Scenario: "],
    alias: { type: "rewrite", value: "Environment setup" } },
  { name: "scenario_setup", kind: "index", start: ["# Scenario: "], end: [">>>>>>>>>>>>>>>>"], alias: { type: "rewrite", value: "Setup" } },
  { name: "step", kind: "index", start: [">>>>>>>>>>>>>>>>"], end: [">>>>>>>>>>>>>>>>", "# Scenario completed: "],
    alias: { type: "regex", value: ">>>>>>>>>>>>>>>>(.*?)<<<<<<<<<<<<<<<<" } },
  { name: "teardown", kind: "index", start: ["# Scenario completed: "], end: ["# Scenario:", "short test summary info"],
    alias: { type: "rewrite", value: "Teardown" } },
];
const withSections = { blocks: sections };
const levels = (text, setup = {}) => parse(text, setup).map((l) => [l.level, l.message]);
const temp = (name) => mkdtempSync(join(tmpdir(), `thumbdeck-${name}-`));

// ------------------------------------------------------------ the setup

test("the default setup is valid, and so are the test sections", () => {
  assert.deepEqual(problems({}), []);
  assert.deepEqual(problems(withSections), []);
  assert.deepEqual(complete({ folders: ["out"] }).folders, ["out"]);
  assert.equal(complete({}).title, "Logs");
  assert.deepEqual(complete({ fields: { level: ["lvl"] } }).fields.message, ["message", "msg", "event", "text", "log"], "missing field names filled in");
});

test("problems are found", () => {
  const p = problems({
    folders: [" "], pattern: "[", line_pattern: "(?P<time>x)",
    blocks: [{ name: "b", kind: "index", start: [], end: [], alias: { type: "regex", value: "no group" } }],
  });
  assert.equal(p.length, 5, JSON.stringify(p));
  assert.ok(problems({ line_pattern: "(" })[0].startsWith("line pattern:"));
});

// ------------------------------------------------------------ entries

test("JSON lines", () => {
  const lines = parse(SAMPLE, {});
  assert.equal(lines.length, 28);
  assert.equal(lines[9].level, "ERROR");
  assert.equal(lines[0].time, "2026-07-31 10:00:00,001");
  assert.equal(lines[0].data.message, "Read 'ppe.yml' configuration file.");
});

test("JSON from other tools", () => {
  // pino: numeric levels, epoch milliseconds, msg
  const pino = parse('{"level":50,"time":1785492000123,"msg":"db down"}', {});
  assert.deepEqual([pino[0].level, pino[0].message], ["ERROR", "db down"]);
  assert.equal(pino[0].time, epoch(1785492000123), "local time");
  assert.equal(dateText(1785492000123), "2026-07-31 10:00:00,123");
  // structlog / zap
  const s = parse('{"event": "started", "level": "warning", "timestamp": "2026-07-31T10:00:00Z"}\n{"severity": "CRITICAL", "message": "x"}\nnot json\n42', {});
  assert.deepEqual([s[0].level, s[0].message], ["WARNING", "started"]);
  assert.equal(s[1].level, "ERROR");
  assert.deepEqual([s[2].level, s[2].message], ["UNKNOWN", "not json"]);
  assert.equal(s[3].message, "42");
  assert.equal(parse('{"lvl": "dbg", "message": "m"}', { fields: { level: ["lvl"] } })[0].level, "DEBUG");
});

test("plain Python logging with a traceback", () => {
  const l = levels("2026-07-31 10:00:00,000 INFO    started\n2026-07-31 10:00:00,100 ERROR   something broke\n"
    + 'Traceback (most recent call last):\n  File "x.py", line 1\n2026-07-31 10:00:01,000 WARNING slow\n');
  assert.equal(l.length, 3, "the traceback belongs to the error");
  assert.equal(l[1][0], "ERROR");
  assert.ok(l[1][1].startsWith("something broke\nTraceback"));
  assert.equal(l[0][1], "started", "the level isn't repeated in the message");
  assert.equal(l[2][0], "WARNING");
  assert.equal(parse("2026-07-31 10:00:00,000 INFO x", {})[0].time, "2026-07-31 10:00:00,000");
});

test("plain logs from other tools", () => {
  // Rust (env_logger / tracing), Go (logfmt), Django runserver, nginx access, syslog
  const l = levels("[2026-07-31T10:00:00Z ERROR app] failed\n2026-07-31T10:00:01Z  WARN app: slow\n");
  assert.deepEqual([l[0][0], l[1][0]], ["ERROR", "WARNING"]);
  assert.equal(levels('time=2026-07-31T10:00:00Z level=error msg="no db"')[0][0], "ERROR");
  const django = levels('[31/Jul/2026 10:00:00] "GET / HTTP/1.1" 200 512\n[31/Jul/2026 10:00:01] "GET /x HTTP/1.1" 404 10\n[31/Jul/2026 10:00:02] "POST /y HTTP/1.1" 500 99\n');
  assert.deepEqual(django.map((x) => x[0]), ["INFO", "WARNING", "ERROR"]);
  assert.equal(django[0][1], '"GET / HTTP/1.1" 200 512', "the time isn't repeated in the message");
  assert.equal(levels("Jul 31 10:00:00 host sshd[1]: error: bad key")[0][0], "UNKNOWN", "lowercase words aren't levels");
  assert.equal(levels("Jul 31 10:00:00 host kernel: <error> disk")[0][0], "ERROR");
});

test("plain output without times", () => {
  // e.g. a build or test run: every line an entry, indented ones belong to the line above
  const l = levels("Compiling app\nerror[E0425]: cannot find value `x`\n  --> src/main.rs:2:5\nFAILED tests::a\n");
  assert.equal(l.length, 3);
  assert.ok(l[1][1].endsWith("--> src/main.rs:2:5"));
  assert.equal(l[0][0], "UNKNOWN");
});

test("a line pattern from the setup", () => {
  const lines = parse("E boom\n  more\nI fine\n", { line_pattern: String.raw`^(?P<level>\w) (?P<message>.*)$` });
  assert.deepEqual(lines.map((l) => l.level), ["ERROR", "INFO"]);
  assert.equal(lines[0].message, "boom\n  more");
});

test("levels from every tool land in four groups", () => {
  for (const [text, want] of [["trace", "DEBUG"], ["Debug", "DEBUG"], ["notice", "INFO"], ["WARN", "WARNING"], ["fatal", "ERROR"],
    ["CRITICAL", "ERROR"], ["20", "DEBUG"], ["30", "INFO"], ["40", "WARNING"], ["60", "ERROR"], ["chatty", "UNKNOWN"]]) {
    assert.equal(level(text), want, text);
  }
});

// ------------------------------------------------------------ sections and the outline

test("sections", () => {
  const lines = parse(SAMPLE, withSections);
  const all = blocks(lines, sections);
  const names = (kind) => all.filter((b) => b.kind === kind).map((b) => b.name);
  assert.deepEqual(names("bookmark"), ["Login works", "Logout works"]);
  const inner = names("index");
  assert.ok(inner.includes("Environment setup"));
  assert.equal(inner.filter((n) => n === "Setup").length, 2);
  assert.ok(inner.includes("When I submit valid credentials"), "titles from the regex");
  const login = all.find((b) => b.name === "Login works");
  assert.deepEqual([login.first_line, login.last_line], [2, 16], "ends at the next start");
  const open = blocks(lines.slice(0, 20), sections);
  assert.equal(open.find((b) => b.name === "Logout works").last_line, null, "runs to the end");
});

test("titles", () => {
  assert.equal(title("# A #", { type: "regex", value: "# (.*?) #" }), "A");
  assert.equal(title("line\nmore", { type: "regex", value: "line.(more)" }), "more", "regex sees newlines");
  assert.equal(title("no match", { type: "regex", value: "x(y)" }), "no match");
  assert.equal(title("a-b", { type: "replace", value: { from: "-", to: " to " } }), "a to b");
  assert.equal(title("b", { type: "prefix", value: "a " }), "a b");
  assert.equal(title("b", { type: "rewrite", value: "Setup" }), "Setup");
  assert.equal(title("b", null), "b");
});

const tree = () => {
  const lines = parse(SAMPLE, withSections);
  return outline(lines, blocks(lines, sections));
};
const flatten = (nodes) => nodes.flatMap((n) => (n.type === "block" ? [n, ...flatten(n.children)] : [n]));
const bookmark = (nodes, name) => flatten(nodes).find((n) => n.type === "block" && n.kind === "bookmark" && n.name === name);

test("every line appears exactly once", () => {
  const seen = flatten(tree()).filter((n) => n.type === "line").map((n) => n.line).sort((a, b) => a - b);
  assert.deepEqual(seen, [...Array(28).keys()]);
});

test("bookmarks aren't dropped by a shared boundary, and errors bubble up", () => {
  const o = tree();
  assert.deepEqual(flatten(o).filter((n) => n.type === "block" && n.kind === "bookmark").map((n) => n.name), ["Login works", "Logout works"]);
  assert.equal(bookmark(o, "Login works").has_error, true);
  assert.equal(bookmark(o, "Logout works").has_error, false);
});

test("indices nest under their bookmark", () => {
  const o = tree();
  const names = bookmark(o, "Login works").children.filter((c) => c.type === "block" && c.kind === "index").map((c) => c.name);
  assert.deepEqual(names, ["Setup", "Given I am on the login page", "When I submit valid credentials", "Then I should see the dashboard", "Teardown"]);
  assert.ok(o[0].type === "block" && o[0].kind === "index" && o[0].name === "Environment setup");
});

test("a flat log is just lines", () => {
  const o = outline(parse(SAMPLE, {}), []);
  assert.equal(o.length, 28);
  assert.ok(o.every((n) => n.type === "line"));
  assert.deepEqual(outline([], []), []);
});

// ------------------------------------------------------------ files

test("logs are listed newest first across folders, with their status", () => {
  const d = temp("logs-list");
  mkdirSync(join(d, "logs"));
  mkdirSync(join(d, "reports"));
  writeFileSync(join(d, "logs/a.log"), SAMPLE);
  writeFileSync(join(d, "reports/b.log"), '{"level": "INFO", "message": "ok"}');
  writeFileSync(join(d, "logs/notes.txt"), "");
  const later = new Date(Date.now() + 10_000);
  utimesSync(join(d, "reports/b.log"), later, later);
  const { files, missing } = list(d, { ...withSections, folders: ["logs", "reports", "gone", "logs"] });
  assert.deepEqual(files.map((f) => [f.name, f.error]), [["b.log", false], ["a.log", true]], "newest first, no duplicates, only *.log");
  assert.deepEqual(missing, ["gone"]);
  // The error flag follows changes
  writeFileSync(join(d, "reports/b.log"), '{"level": "INFO", "message": "ok"}\n{"level": "ERROR", "message": "no"}\n');
  assert.equal(list(d, { folders: ["reports"] }).files[0].error, true);
  rmSync(d, { recursive: true });
});

test("open and summarize", () => {
  const d = temp("logs-open");
  writeFileSync(join(d, "run.log"), SAMPLE);
  assert.equal(open(join(d, "run.log"), withSections).lines.length, 28);
  const s = summary(join(d, "run.log"), withSections);
  assert.equal(s.total, 28);
  assert.equal(s.blocks, 3, "sections: Environment setup, Login works, Logout works");
  assert.deepEqual(s.levels[3], ["ERROR", 2]);
  assert.equal(s.first_error, "Element '#submit-button' not found after 10s timeout");
  assert.equal(s.duration, "2.7s");
  assert.throws(() => open(join(d, "missing.log"), withSections));
  rmSync(d, { recursive: true });
});

test("timestamps and durations", () => {
  assert.equal(timestamp("2026-08-01T00:01:00.000") - timestamp("2026-07-31 23:59:59,500"), 60.5);
  assert.equal(timestamp("yesterday"), null);
  assert.equal(formatDuration(2.72), "2.7s");
  assert.equal(formatDuration(125), "2m 5s");
  assert.equal(formatDuration(7300), "2h 1m");
});
