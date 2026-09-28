// Reading Claude Code's own files: a project's sessions (~/.claude/projects/<folder>/<session>.jsonl,
// its subagents in <session>/subagents/), the subagents and skills defined for it, and the
// sessions running right now (~/.claude/sessions/<pid>.json). The format isn't documented, so
// everything is read defensively: records it doesn't know are skipped, and a file it can't
// read is reported, not guessed at. Tested with `node --test` (claude.test.js).
import { closeSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs";
import { basename, join } from "node:path";

/** Mid-turn with nothing written for this long: probably interrupted */
const QUIET_MS = 600_000;
/** Tool results and inputs longer than this are cut for the view */
const LONG = 4000;

/** Claude Code's folder: $CLAUDE_CONFIG_DIR, or ~/.claude */
export function claudeHome(env = process.env) {
  return env.CLAUDE_CONFIG_DIR || join(env.HOME ?? "", ".claude");
}

/** Where Claude Code keeps a folder's sessions: its path with everything but letters and digits
 *  turned into "-" ("/home/me/dev/app" -> "-home-me-dev-app") */
export const sessionsDir = (home, project) => join(home, "projects", project.replace(/[^A-Za-z0-9]/g, "-"));

/** Text cut to `max` characters (whole characters, not UTF-16 halves), with … */
function cutChars(text, max) {
  const chars = Array.from(text);
  return chars.length > max ? `${chars.slice(0, max).join("")}…` : text;
}

/** One line, cut to `max` characters */
export const shorten = (text, max) => cutChars(text.split(/\s+/).filter(Boolean).join(" "), max);

/** A message Claude Code sends itself, like a subagent's "I'm done" (it starts a turn, but you
 *  didn't type it) */
export const injected = (r) => r?.promptSource === "system" || (typeof r?.origin?.kind === "string" && r.origin.kind !== "user");

/** The text of a user message, if it's one you typed (not a tool result or something injected) */
export function promptText(r) {
  if (r?.isMeta === true || injected(r)) return null;
  const content = r?.message?.content;
  let text;
  if (typeof content === "string") text = content;
  else if (Array.isArray(content)) {
    if (content.some((p) => p?.type === "tool_result")) return null;
    text = content.filter((p) => typeof p?.text === "string").map((p) => p.text).join("\n");
  } else return null;
  text = text.trim();
  // Slash-command plumbing and interrupt markers aren't prompts
  if (!text || text.startsWith("<command-") || text.startsWith("<local-command") || text.startsWith("[Request interrupted")) return null;
  return text;
}

// ------------------------------------------------------------ summing a transcript up

const newFold = () => ({
  title: null, firstPrompt: null, started: null, last: null, model: null, branch: null,
  cost: null, costBehind: false, prompts: 0, turnOpen: false, usage: {},
});

function apply(f, r) {
  if (typeof r?.timestamp === "string") {
    f.started ??= r.timestamp;
    f.last = r.timestamp;
  }
  if (typeof r?.gitBranch === "string" && r.gitBranch) f.branch = r.gitBranch;
  switch (r?.type) {
    case "ai-title":
      f.title = typeof r.aiTitle === "string" ? r.aiTitle : null;
      break;
    case "cost-state":
      if (typeof r.totalCostUSD === "number") f.cost = r.totalCostUSD;
      f.costBehind = false;
      break;
    case "queue-operation":
      if (r.operation === "enqueue") f.turnOpen = true;
      break;
    case "user": {
      const text = promptText(r);
      if (text !== null) {
        f.prompts += 1;
        f.firstPrompt ??= text;
        f.turnOpen = true;
      } else if (injected(r) || (Array.isArray(r.message?.content) && r.message.content.some((p) => p?.type === "tool_result"))) {
        f.turnOpen = true;
      }
      break;
    }
    case "assistant": {
      const m = r.message;
      if (!m) break;
      if (typeof m.model === "string" && !m.model.startsWith("<")) f.model = m.model;
      if (typeof m.id === "string" && m.usage) {
        const n = (k) => (typeof m.usage[k] === "number" ? m.usage[k] : 0);
        // A message's content blocks come as separate records with the same usage
        f.usage[m.id] = { input: n("input_tokens"), output: n("output_tokens"), cache_read: n("cache_read_input_tokens"), cache_write: n("cache_creation_input_tokens") };
        f.costBehind = true;
      }
      if (m.stop_reason === "tool_use") f.turnOpen = true;
      else if (typeof m.stop_reason === "string") f.turnOpen = false; // end_turn, max_tokens, …
      break;
    }
    // attachments, snapshots, modes, and whatever comes next
  }
}

const tokens = (f) =>
  Object.values(f.usage).reduce(
    (a, t) => ({ input: a.input + t.input, output: a.output + t.output, cache_read: a.cache_read + t.cache_read, cache_write: a.cache_write + t.cache_write }),
    { input: 0, output: 0, cache_read: 0, cache_write: 0 },
  );

const status = (f, modified, now) => (!f.turnOpen ? "idle" : now - modified > QUIET_MS ? "stale" : "working");

/** Read a transcript, from where the last look stopped when it only grew since. `seen` keeps
 *  what was read (path -> { offset, fold }). */
export function foldFile(path, seen) {
  let st;
  try {
    st = statSync(path);
  } catch {
    return null;
  }
  let { offset, fold } = seen.get(path) ?? { offset: 0, fold: newFold() };
  if (offset > st.size) ({ offset, fold } = { offset: 0, fold: newFold() }); // rewritten shorter
  fold = structuredClone(fold);
  if (offset < st.size) {
    const fd = openSync(path, "r");
    try {
      const bytes = Buffer.alloc(st.size - offset);
      readSync(fd, bytes, 0, bytes.length, offset);
      // Only whole lines: the last one may still be being written
      const end = bytes.lastIndexOf(0x0a) + 1;
      for (const line of bytes.subarray(0, end).toString("utf8").split("\n")) {
        if (!line) continue;
        try {
          apply(fold, JSON.parse(line));
        } catch {}
      }
      offset += end;
    } finally {
      closeSync(fd);
    }
  }
  seen.set(path, { offset, fold });
  return { fold, modified: st.mtimeMs };
}

const jsonlIn = (dir) => {
  try {
    return readdirSync(dir).filter((n) => n.endsWith(".jsonl")).map((n) => join(dir, n));
  } catch {
    return [];
  }
};

/** A project's sessions (in its sessions folder), most recent first */
export function listSessions(dir, seen, now = Date.now()) {
  return jsonlIn(dir)
    .map((p) => session(p, seen, now))
    .filter(Boolean)
    .sort((a, b) => (b.last_activity > a.last_activity ? 1 : b.last_activity < a.last_activity ? -1 : 0));
}

export function session(path, seen, now = Date.now()) {
  const read = foldFile(path, seen);
  if (!read?.fold.started) return null; // a file with no conversation in it isn't worth listing
  const { fold: f, modified } = read;
  const first = f.firstPrompt ?? "";
  return {
    id: basename(path, ".jsonl"),
    title: f.title ?? shorten(first, 80),
    first_prompt: shorten(first, 400),
    started: f.started ?? "",
    last_activity: f.last ?? "",
    model: f.model,
    branch: f.branch,
    tokens: tokens(f),
    cost: f.cost,
    cost_behind: f.costBehind && f.cost !== null,
    prompts: f.prompts,
    status: status(f, modified, now),
    subagents: subagents(join(path.slice(0, -".jsonl".length), "subagents"), seen, now),
    file: path,
  };
}

/** A session's subagents: agent-<id>.jsonl with agent-<id>.meta.json next to it */
function subagents(dir, seen, now) {
  return jsonlIn(dir)
    .map((p) => {
      const read = foldFile(p, seen);
      if (!read) return null;
      const { fold: f, modified } = read;
      let meta = {};
      try {
        meta = JSON.parse(readFileSync(p.replace(/\.jsonl$/, ".meta.json"), "utf8")) ?? {};
      } catch {}
      const stem = basename(p, ".jsonl");
      return {
        id: stem.replace(/^agent-/, ""),
        agent_type: typeof meta.agentType === "string" && meta.agentType ? meta.agentType : "subagent",
        description: typeof meta.description === "string" ? meta.description : "",
        model: f.model,
        tokens: tokens(f),
        status: status(f, modified, now),
        started: f.started ?? "",
        last_activity: f.last ?? "",
        depth: Number.isInteger(meta.spawnDepth) ? meta.spawnDepth : 1,
        file: p,
      };
    })
    .filter(Boolean)
    .sort((a, b) => (a.started > b.started ? 1 : a.started < b.started ? -1 : 0));
}

// ------------------------------------------------------------ defined subagents and skills

/** The frontmatter's simple "key: value" lines (and "- item" lists), and the body after it.
 *  Nested values (hooks, mcpServers) aren't needed here and are skipped. */
export function frontmatter(text) {
  const m = /^---[ \r]*\n/.exec(text);
  if (!m) return null;
  const rest = text.slice(m[0].length);
  const end = rest.indexOf("\n---");
  if (end < 0) return null;
  const head = rest.slice(0, end);
  const after = rest.slice(end + 4);
  const body = (after.includes("\n") ? after.slice(after.indexOf("\n") + 1) : "").trim();
  const fields = [];
  for (const line of head.split("\n")) {
    const item = /^\s*- (.*)$/.exec(line);
    if (item) {
      // An item of the list started by the last key ("tools:\n  - Read")
      if (/^[ \t]/.test(line) && fields.length) {
        const last = fields[fields.length - 1];
        last[1] = last[1] ? `${last[1]}, ${item[1].trim()}` : item[1].trim();
      }
      continue;
    }
    if (/^[ \t]/.test(line) || !line.trim() || line.trim().startsWith("#")) continue;
    const at = line.indexOf(":");
    if (at > 0) fields.push([line.slice(0, at).trim(), line.slice(at + 1).trim().replace(/^["']+|["']+$/g, "")]);
  }
  return { fields, body };
}

const getter = (fields) => (k) => {
  const found = [...fields].reverse().find(([key]) => key === k);
  return found && found[1] ? found[1] : null;
};

function parseDefined(text, scope, file) {
  const fm = frontmatter(text);
  if (!fm) return null;
  const get = getter(fm.fields);
  const name = get("name");
  if (!name) return null;
  const tools = get("tools");
  return {
    name,
    description: get("description") ?? "",
    tools: tools ? tools.replace(/^\[|\]$/g, "").split(",").map((s) => s.trim().replace(/^["']+|["']+$/g, "")).filter(Boolean) : [],
    model: get("model"),
    color: get("color"),
    scope,
    file,
    instructions: fm.body,
  };
}

/** The subagents in a folder of definitions (.claude/agents/*.md); files that aren't one are skipped */
export function listDefined(dir, scope) {
  let names = [];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith(".md"));
  } catch {}
  return names
    .map((n) => {
      try {
        return parseDefined(readFileSync(join(dir, n), "utf8"), scope, join(dir, n));
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** The skills in a skills folder (<name>/SKILL.md); folders without a readable SKILL.md are skipped */
export function listSkills(dir, scope) {
  let names = [];
  try {
    names = readdirSync(dir);
  } catch {}
  return names
    .map((folder) => {
      const file = join(dir, folder, "SKILL.md");
      let fm;
      try {
        fm = frontmatter(readFileSync(file, "utf8"));
      } catch {
        return null;
      }
      if (!fm) return null;
      const get = getter(fm.fields);
      return { name: get("name") ?? folder, description: get("description") ?? "", scope, file, instructions: fm.body };
    })
    .filter(Boolean)
    .sort((a, b) => a.name.localeCompare(b.name));
}

// ------------------------------------------------------------ a conversation, for reading

const cutValue = (v) =>
  typeof v === "string" ? cutChars(v, LONG)
  : Array.isArray(v) ? v.map(cutValue)
  : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, cutValue(x)]))
  : v;

/** A tool result's content: text, or text blocks (images and the like are named) */
function resultText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((p) => (p?.type === "text" ? p.text ?? "" : p?.type ? `[${p.type}]` : "")).join("\n");
  if (content == null) return "";
  return JSON.stringify(content);
}

/** The text between <name> and </name> */
function tag(body, name) {
  const start = body.indexOf(`<${name}>`);
  if (start < 0) return null;
  const from = start + name.length + 2;
  const end = body.indexOf(`</${name}>`, from);
  if (end < 0) return null;
  return body.slice(from, end).trim() || null;
}

/** A message Claude Code sent itself, in words: a subagent's notice says what finished and its result */
export function notice(r, body) {
  const summary = tag(body, "summary");
  if (summary) {
    const result = tag(body, "result");
    return result ? `subagent: ${summary} → ${shorten(result, 160)}` : `subagent: ${summary}`;
  }
  const kind = (typeof r?.origin?.kind === "string" ? r.origin.kind : "message").replace(/-/g, " ");
  // Otherwise the words between the tags
  const words = body.split(/[<>]/).filter((_, i) => i % 2 === 0);
  return `${kind}: ${shorten(words.join(" "), 200)}`;
}

/** A session's (or subagent's) conversation: your prompts, the answers, and each tool call
 *  with its result; a call that started a subagent points at it */
export function transcript(path) {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    throw new Error(`couldn't read ${path}: ${e.message}`);
  }
  const out = [];
  const tools = new Map(); // tool_use id -> index in out
  for (const line of text.split("\n")) {
    let r;
    try {
      r = JSON.parse(line);
    } catch {
      continue;
    }
    const time = typeof r.timestamp === "string" ? r.timestamp : "";
    const content = r.message?.content;
    if (r.type === "user") {
      const prompt = promptText(r);
      if (prompt !== null) {
        out.push({ kind: "prompt", time, text: prompt });
        continue;
      }
      if (injected(r)) {
        out.push({ kind: "note", time, text: notice(r, resultText(content ?? null)) });
        continue;
      }
      const parts = Array.isArray(content) ? content : [];
      for (const part of parts.filter((p) => p?.type === "tool_result")) {
        const full = resultText(part.content ?? null);
        const result = { text: cutChars(full, LONG), error: part.is_error === true, length: Array.from(full).length };
        const agent = typeof r.toolUseResult?.agentId === "string" ? r.toolUseResult.agentId : null;
        const call = out[tools.get(part.tool_use_id)];
        if (call?.kind === "tool") {
          call.result = result;
          if (agent) call.agent = agent;
        } else out.push({ kind: "note", time, text: `result of an earlier call: ${result.text}` });
      }
      const interrupted = typeof content === "string" ? content : parts.find((p) => typeof p?.text === "string")?.text;
      if (interrupted?.startsWith("[Request interrupted")) out.push({ kind: "note", time, text: interrupted.replace(/^\[+|\]+$/g, "") });
    } else if (r.type === "assistant") {
      for (const part of Array.isArray(content) ? content : []) {
        if (part?.type === "text") {
          const t = (part.text ?? "").trim();
          if (t) out.push({ kind: "text", time, text: t });
        } else if (part?.type === "tool_use") {
          const id = typeof part.id === "string" ? part.id : "";
          tools.set(id, out.length);
          out.push({ kind: "tool", time, id, name: typeof part.name === "string" ? part.name : "tool", input: cutValue(part.input ?? null), result: null, agent: null });
        }
        // thinking, and anything new
      }
    } else if (r.type === "system") {
      const t = typeof r.content === "string" ? r.content.trim() : "";
      if (t && r.isMeta !== true) out.push({ kind: "note", time, text: cutChars(t, LONG) });
    }
  }
  return out;
}

// ------------------------------------------------------------ sessions running right now

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM"; // there, but someone else's
  }
};

/** The Claude Code sessions running now, in any project: { session_id, cwd, status } */
export function live(home) {
  const dir = join(home, "sessions");
  let names = [];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith(".json"));
  } catch {
    return [];
  }
  return names
    .map((n) => {
      try {
        const v = JSON.parse(readFileSync(join(dir, n), "utf8"));
        if (!Number.isInteger(v?.pid) || v.pid <= 0 || !alive(v.pid)) return null;
        const text = (k) => (typeof v[k] === "string" ? v[k] : "");
        return { session_id: text("sessionId"), cwd: text("cwd"), status: text("status") };
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

// ------------------------------------------------------------ starting one

/** Quoted for the shell, in a form bash, zsh and fish all read the same way */
const quote = (s) => `'${s.replace(/'/g, "'\\''")}'`;

/** The command that starts Claude Code on a task: as one of the defined agents ("agent"), or
 *  with a skill ("skill", the task after "/skill"). The task is one line: typed into a shell, a
 *  newline would end the command early. */
export function startCommand(kind, name, task) {
  task = task.split(/\s+/).filter(Boolean).join(" ");
  if (kind === "agent") return task ? `claude --agent ${quote(name)} ${quote(task)}` : `claude --agent ${quote(name)}`;
  if (kind === "skill") return `claude ${quote(`/${name} ${task}`.trimEnd())}`;
  throw new Error(`can't start a ${kind}`);
}
