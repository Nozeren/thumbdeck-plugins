import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  injected, listDefined, listSessions, listSkills, live, notice, promptText, session, sessionsDir, shorten, startCommand, transcript,
} from "./claude.js";

const testdata = fileURLToPath(new URL("./testdata", import.meta.url));
const SESSION = "5651334b-4fd2-4111-8f2b-8efe1d44f2f0";
const temp = (name) => mkdtempSync(join(tmpdir(), `thumbdeck-${name}-`));

test("session folders are named after the project path", () => {
  assert.equal(sessionsDir("/h/.claude", "/home/me/dev/thumbdeck"), "/h/.claude/projects/-home-me-dev-thumbdeck");
  assert.equal(sessionsDir("/h/.claude", "/tmp/a-b/c.d_e"), "/h/.claude/projects/-tmp-a-b-c-d-e");
});

test("start commands", () => {
  assert.equal(startCommand("agent", "counter", ""), "claude --agent 'counter'");
  assert.equal(startCommand("agent", "counter", "count\n the  files"), "claude --agent 'counter' 'count the files'");
  assert.equal(startCommand("skill", "tidy", "src/it's.rs"), "claude '/tidy src/it'\\''s.rs'");
  assert.equal(startCommand("skill", "tidy", " "), "claude '/tidy'");
  assert.throws(() => startCommand("x", "y", ""));
});

test("a real session with a subagent", () => {
  const list = listSessions(join(testdata, "session"), new Map());
  assert.equal(list.length, 1);
  const s = list[0];
  assert.equal(s.id, SESSION);
  assert.ok(s.title.startsWith("Use the counter subagent"), "no ai-title: the first prompt");
  assert.equal(s.prompts, 1);
  assert.equal(s.model, "claude-haiku-4-5-20251001");
  assert.ok(s.tokens.output > 0 && s.tokens.input + s.tokens.cache_read > 0);
  assert.ok(s.cost > 0 && s.cost < 0.1);
  assert.equal(s.cost_behind, false, "the total was written after the last answer");
  assert.equal(s.status, "idle", "it answered");
  assert.equal(s.subagents.length, 1);
  const a = s.subagents[0];
  assert.deepEqual([a.id, a.agent_type, a.description, a.status, a.depth], ["aebb35f6fa412bbf6", "counter", "Count files in the current folder", "idle", 1]);
  assert.ok(a.tokens.output > 0);
});

const line = (v) => `${JSON.stringify(v)}\n`;
const user = (text) => line({ type: "user", timestamp: "2026-09-26T10:00:00Z", message: { role: "user", content: text } });
const assistant = (id, stop, output) =>
  line({ type: "assistant", timestamp: "2026-09-26T10:00:05Z", message: { id, model: "claude-opus-5-5", stop_reason: stop, usage: { input_tokens: 10, output_tokens: output, cache_read_input_tokens: 100 } } });

test("status, tokens and growing files", () => {
  const d = temp("agents-fold");
  const path = join(d, "s1.jsonl");
  const seen = new Map();
  // A prompt, then an answer that calls a tool: working
  writeFileSync(path, user("fix the build") + assistant("m1", null, 5) + assistant("m1", "tool_use", 7));
  let s = session(path, seen);
  assert.equal(s.status, "working");
  assert.deepEqual(s.tokens, { input: 10, output: 7, cache_read: 100, cache_write: 0 }, "a message's usage counted once");
  assert.equal(s.title, "fix the build");
  assert.ok(s.cost === null && !s.cost_behind, "no total written: no cost");

  // It grows: the tool result, a final answer, a title; a half-written line at the end is left for later
  appendFileSync(path, line({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t", content: "ok" }] } })
    + assistant("m2", "end_turn", 3) + line({ type: "ai-title", aiTitle: "Fix the build" }) + '{"type": "assist');
  s = session(path, seen);
  assert.deepEqual([s.status, s.title, s.tokens.output, s.prompts], ["idle", "Fix the build", 10, 1], "a tool result isn't a prompt");

  // Rewritten shorter (not grown): read again from the start
  writeFileSync(path, user("again"));
  s = session(path, seen);
  assert.deepEqual([s.title, s.status, s.tokens.output], ["again", "working", 0]);

  // Mid-turn but quiet for long: stale
  const old = new Date(Date.now() - 3600_000);
  utimesSync(path, old, old);
  assert.equal(session(path, seen).status, "stale");
  rmSync(d, { recursive: true });
});

test("what counts as a prompt", () => {
  const v = (c) => ({ type: "user", message: { content: c } });
  assert.equal(promptText(v("hi")), "hi");
  assert.equal(promptText(v([{ type: "text", text: "hi" }])), "hi");
  assert.equal(promptText(v([{ type: "tool_result", content: "x" }])), null);
  assert.equal(promptText(v("<command-name>/clear</command-name>")), null);
  assert.equal(promptText(v("[Request interrupted by user]")), null);
  assert.equal(promptText({ ...v("injected"), isMeta: true }), null);
  const n = { ...v("<task-notification>done</task-notification>"), origin: { kind: "task-notification" }, promptSource: "system" };
  assert.equal(promptText(n), null, "a subagent's notice isn't your prompt");
  assert.ok(injected(n));
});

test("files without a conversation or folder are skipped", () => {
  const d = temp("agents-empty");
  writeFileSync(join(d, "settings-only.jsonl"), '{"type": "mode"}\nnot json\n');
  assert.deepEqual(listSessions(d, new Map()), []);
  assert.deepEqual(listSessions(join(d, "missing"), new Map()), []);
  assert.equal(shorten("a  b\nc", 10), "a b c");
  assert.equal(shorten("abcdef", 3), "abc…");
  rmSync(d, { recursive: true });
});

test("the test project's counter agent and tidy skill", () => {
  const agents = listDefined(join(testdata, "project/.claude/agents"), "project");
  assert.equal(agents.length, 1);
  const a = agents[0];
  assert.deepEqual([a.name, a.scope, a.model, a.color], ["counter", "project", "haiku", "green"]);
  assert.ok(a.description.startsWith("Counts the files"));
  assert.deepEqual(a.tools, ["Glob"]);
  assert.ok(a.instructions.startsWith("Count the files"));
  const skills = listSkills(join(testdata, "project/.claude/skills"), "project");
  assert.deepEqual([skills[0].name, skills[0].scope], ["tidy", "project"]);
  assert.ok(skills[0].description.startsWith("Tidies up") && skills[0].instructions.startsWith("Sort the imports"));
  assert.deepEqual(listDefined("/missing", "user"), []);
  assert.deepEqual(listSkills("/missing", "user"), []);
});

test("frontmatter forms", () => {
  const d = temp("agents-defined");
  writeFileSync(join(d, "a.md"), "---\nname: \"reviewer\"\ntools:\n  - Read\n  - Grep\nhooks:\n  PreToolUse:\n    - matcher: Bash\n---\nReview.");
  writeFileSync(join(d, "b.md"), "---\nname: x\ntools: [Read, 'Edit']\n---\n");
  writeFileSync(join(d, "c.md"), "no frontmatter");
  writeFileSync(join(d, "d.md"), "---\ndescription: no name\n---\n");
  const list = listDefined(d, "user");
  assert.deepEqual(list.map((a) => [a.name, a.tools]), [["reviewer", ["Read", "Grep"]], ["x", ["Read", "Edit"]]], "the nested hooks list isn't taken for tools");
  assert.equal(list[0].instructions, "Review.");
  mkdirSync(join(d, "skills/fix-it"), { recursive: true });
  writeFileSync(join(d, "skills/fix-it/SKILL.md"), "---\ndescription: d\n---\nbody");
  assert.equal(listSkills(join(d, "skills"), "user")[0].name, "fix-it", "no name: the folder's");
  rmSync(d, { recursive: true });
});

test("the real session reads as prompt, call and answer", () => {
  const entries = transcript(join(testdata, `session/${SESSION}.jsonl`));
  assert.equal(entries[0].kind, "prompt");
  assert.ok(entries[0].text.startsWith("Use the counter subagent"));
  const agent = entries.find((e) => e.kind === "tool" && e.name === "Agent");
  assert.equal(agent.input.subagent_type, "counter");
  assert.equal(agent.agent, "aebb35f6fa412bbf6", "the call points at its subagent");
  assert.ok(agent.result);
  assert.ok(entries.at(-1).kind === "text" && entries.at(-1).text.includes("3"));
  const notes = entries.filter((e) => e.kind === "note").map((e) => e.text);
  assert.deepEqual(notes, ['subagent: Agent "Count files in the current folder" finished → 3']);
  assert.equal(notice({ origin: { kind: "scheduled-task" } }, "<a>wake</a> <b>up</b>"), "scheduled task: wake up");
  const sub = transcript(join(testdata, `session/${SESSION}/subagents/agent-aebb35f6fa412bbf6.jsonl`));
  assert.ok(sub.some((e) => e.kind === "tool" && e.name === "Glob" && e.result));
  assert.throws(() => transcript("/nonexistent.jsonl"));
});

test("long results are cut and errors kept", () => {
  const d = temp("agents-transcript");
  const long = "x".repeat(4010);
  writeFileSync(join(d, "t.jsonl"), [
    { type: "assistant", message: { content: [{ type: "thinking", thinking: "hmm" }, { type: "tool_use", id: "t1", name: "Bash", input: { command: long } }] } },
    { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", is_error: true, content: [{ type: "text", text: long }, { type: "image" }] }] } },
    { type: "user", message: { content: "[Request interrupted by user]" } },
  ].map((l) => JSON.stringify(l)).join("\n"));
  const entries = transcript(join(d, "t.jsonl"));
  assert.equal(entries.length, 2, "thinking isn't shown");
  assert.equal(Array.from(entries[0].input.command).length, 4001, "cut, with …");
  assert.ok(entries[0].result.error && entries[0].result.length === 4010 + "\n[image]".length);
  assert.deepEqual(entries[1], { kind: "note", time: "", text: "Request interrupted by user" });
  rmSync(d, { recursive: true });
});

test("only sessions whose process is alive", () => {
  const home = temp("agents-live");
  mkdirSync(join(home, "sessions"));
  writeFileSync(join(home, "sessions", `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: "s1", cwd: "/p", status: "busy" }));
  // A pid that can't exist: a leftover of a crash
  writeFileSync(join(home, "sessions", "99999999.json"), JSON.stringify({ pid: 99999999, sessionId: "s2", cwd: "/p", status: "idle" }));
  writeFileSync(join(home, "sessions", "1.key"), "not a session");
  writeFileSync(join(home, "sessions", "bad.json"), "{");
  assert.deepEqual(live(home), [{ session_id: "s1", cwd: "/p", status: "busy" }]);
  assert.deepEqual(live("/missing"), []);
  rmSync(home, { recursive: true });
});
