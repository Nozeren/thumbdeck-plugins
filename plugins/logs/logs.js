// Reading logs for the Logs tab: files in the setup's folders, each read into entries (JSON
// lines or plain text, from any tool) and folded into sections that start and end at marker
// texts. Tested with `node --test` (logs.test.js).
import { globSync, readFileSync, statSync } from "node:fs";
import { matchesGlob, resolve } from "node:path";

// ------------------------------------------------------------ the setup

export const DEFAULT_FIELDS = {
  message: ["message", "msg", "event", "text", "log"],
  level: ["level", "levelname", "severity", "lvl", "loglevel"],
  time: ["timestamp", "time", "ts", "@timestamp", "asctime", "datetime", "date"],
};

/** A setup with everything filled in (a setup saved earlier may lack some) */
export function complete(setup = {}) {
  return {
    title: setup.title ?? "Logs",
    folders: Array.isArray(setup.folders) ? setup.folders : [".", "logs", "log"],
    pattern: typeof setup.pattern === "string" && setup.pattern ? setup.pattern : "*.log",
    blocks: Array.isArray(setup.blocks) ? setup.blocks : [],
    fields: { ...DEFAULT_FIELDS, ...(setup.fields && typeof setup.fields === "object" ? setup.fields : {}) },
    line_pattern: typeof setup.line_pattern === "string" ? setup.line_pattern : "",
  };
}

/** A regex written the Python / Rust way ((?P<name>...)) as a JavaScript one */
export const regex = (source, flags = "") => new RegExp(source.replace(/\(\?P</g, "(?<"), flags);

/** How many (groups) a regex has */
const groups = (re) => new RegExp(`${re.source}|`).exec("").length - 1;

/** A glob whose [ ] and { } are closed (Node's own glob matching doesn't complain) */
function validGlob(pattern) {
  let square = false;
  let curly = 0;
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "\\") i++;
    else if (square) square = c !== "]";
    else if (c === "[") square = true;
    else if (c === "{") curly++;
    else if (c === "}" && --curly < 0) return false;
  }
  if (square || curly !== 0) return false;
  try {
    matchesGlob("x", pattern);
    return true;
  } catch {
    return false;
  }
}

/** What's wrong with a setup, if anything (shown in its setup form) */
export function problems(setup) {
  const s = complete(setup);
  const out = [];
  if (s.folders.every((f) => !f.trim())) out.push("add at least one folder");
  if (!validGlob(s.pattern)) out.push(`file pattern '${s.pattern}' isn't a valid glob`);
  if (s.line_pattern) {
    try {
      regex(s.line_pattern);
      if (!/\(\?P?<message>/.test(s.line_pattern)) out.push("the line pattern needs a (?P<message>...) group");
    } catch (e) {
      out.push(`line pattern: ${e.message}`);
    }
  }
  for (const b of s.blocks) {
    if ((b.start ?? []).every((t) => !t)) out.push(`section '${b.name}' needs a start text`);
    if (b.alias?.type === "regex") {
      try {
        if (groups(regex(b.alias.value)) < 1) out.push(`section '${b.name}': the title regex needs a (group)`);
      } catch (e) {
        out.push(`section '${b.name}': ${e.message}`);
      }
    }
  }
  return out;
}

// ------------------------------------------------------------ reading entries

/** Every tool names its levels differently: they're put in the groups the viewer filters by.
 *  Numbers are pino / bunyan levels (30 info, 50 error, ...). */
export function level(text) {
  const t = String(text).trim().toLowerCase();
  if (/^\d+$/.test(t)) {
    const n = Number(t);
    return n < 30 ? "DEBUG" : n < 40 ? "INFO" : n < 50 ? "WARNING" : "ERROR";
  }
  switch (t) {
    case "trace": case "debug": case "verbose": case "fine": case "finer": case "finest": case "dbg": case "d": case "v":
      return "DEBUG";
    case "info": case "information": case "notice": case "inf": case "i":
      return "INFO";
    case "warn": case "warning": case "wrn": case "w":
      return "WARNING";
    case "error": case "err": case "fatal": case "critical": case "crit": case "panic": case "severe": case "alert":
    case "emerg": case "emergency": case "e": case "f":
      return "ERROR";
    default:
      return "UNKNOWN";
  }
}

const text = (v) => (typeof v === "string" ? v : JSON.stringify(v));

/** A JSON entry; a line that isn't a JSON object (in a JSON log) is kept as text */
function jsonLine(raw, fields) {
  let data;
  try {
    const v = JSON.parse(raw);
    data = v && typeof v === "object" && !Array.isArray(v) ? v : { message: v };
  } catch {
    data = { message: raw };
  }
  const field = (names) => names.map((n) => data[n]).find((v) => v !== undefined && v !== null);
  const lvl = field(fields.level);
  const time = field(fields.time);
  const message = field(fields.message);
  return {
    level: lvl === undefined ? "UNKNOWN" : level(text(lvl)),
    time: time === undefined ? "" : typeof time === "number" ? epoch(time) : text(time),
    message: message === undefined ? "" : text(message),
    data,
  };
}

const pad = (n, w = 2) => String(n).padStart(w, "0");

/** Milliseconds since 1970 as a date and time, "2026-07-31 10:00:00,123" (no time zone applied) */
export function dateText(ms) {
  const d = new Date(ms);
  return `${pad(d.getUTCFullYear(), 4)}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())},${pad(d.getUTCMilliseconds(), 3)}`;
}

/** Seconds or milliseconds since 1970 as a date and time in local time, like the times
 *  plain-text logs are written in */
export function epoch(n) {
  const ms = Math.trunc(n > 1e11 ? n : n * 1000);
  return dateText(ms - new Date(ms).getTimezoneOffset() * 60_000);
}

/** A date and/or time at the start of a line: ISO ("2026-07-31 10:00:00,001", "...T...Z"),
 *  time only ("10:00:00.123"), Apache/Django ("[31/Jul/2026:10:00:00 +0000]",
 *  "[31/Jul/2026 10:00:00]"), syslog ("Jul 31 10:00:00"). [time, where the rest starts] */
const LEADING_TIME = new RegExp(
  String.raw`^\[?(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:[.,]\d+)?(?:Z|[+-]\d{2}:?\d{2})?` +
    String.raw`|\d{2}:\d{2}:\d{2}(?:[.,]\d+)?` +
    String.raw`|\d{2}/[A-Za-z]{3}/\d{4}[: ]\d{2}:\d{2}:\d{2}(?: [+-]\d{4})?` +
    String.raw`|[A-Z][a-z]{2} [ \d]\d \d{2}:\d{2}:\d{2})\]?[ \t:|-]*`,
);

function leadingTime(line) {
  const m = LEADING_TIME.exec(line);
  return m ? [m[1], m[0].length] : null;
}

const WORD = /\b(TRACE|DEBUG|INFO|NOTICE|WARN|WARNING|ERROR|ERR|FATAL|CRITICAL|CRIT|PANIC|SEVERE)\b/;
const TAGGED = /(?:level[=:]"?|\[|<)(trace|debug|info|notice|warn|warning|error|err|fatal|critical|panic)\b/i;
const HTTP = /HTTP\/[\d.]+" (\d{3}) /;

/** The level of a plain-text line: a level word in capitals (ERROR, WARN, ...), or level=error,
 *  [error], <error>; else an HTTP status in an access log (5xx error, 4xx warning) */
function lineLevel(line) {
  const found = [WORD.exec(line), TAGGED.exec(line)]
    .filter(Boolean)
    .map((m) => ({ word: m[1], at: m.index + m[0].indexOf(m[1]) }))
    .sort((a, b) => a.at - b.at)[0];
  if (found) return level(found.word);
  const http = HTTP.exec(line);
  if (!http) return "UNKNOWN";
  const status = Number(http[1]);
  return status >= 500 && status <= 599 ? "ERROR" : status >= 400 && status <= 499 ? "WARNING" : "INFO";
}

/** A level word right at the start of a message ("ERROR    Job 7 failed"): the viewer shows the
 *  level in its own column, so it's left out of the message */
const LEVEL_FIRST = /^\[?(?:TRACE|DEBUG|INFO|NOTICE|WARN|WARNING|ERROR|ERR|FATAL|CRITICAL|CRIT|PANIC|SEVERE)\]?(?:[ \t]*[:|-])?[ \t]+/;
const withoutLevel = (message) => message.replace(LEVEL_FIRST, "");

const plainEntry = (time, lvl, message) => ({ level: lvl, time, message, data: { time, level: lvl, message } });

function addTo(prev, line) {
  prev.message += `\n${line}`;
  prev.data.message = prev.message;
  // A traceback under an entry makes it an error
  if ((prev.level === "UNKNOWN" || prev.level === "INFO") && lineLevel(line) === "ERROR") {
    prev.level = "ERROR";
    prev.data.level = "ERROR";
  }
}

/** Plain text without a pattern. When the log's lines start with a time, a line without one (a
 *  traceback, wrapped output) belongs to the entry above; otherwise each line is an entry,
 *  except indented ones, which belong to the line above. */
function plainLines(raw) {
  const timestamped = raw.length > 0 && leadingTime(raw[0]) !== null;
  const out = [];
  for (const l of raw) {
    const time = leadingTime(l);
    const continues = timestamped ? time === null : /^[ \t]/.test(l);
    if (continues && out.length) {
      addTo(out[out.length - 1], l);
      continue;
    }
    const [t, rest] = time ? [time[0], withoutLevel(l.slice(time[1]))] : ["", l];
    out.push(plainEntry(t, lineLevel(l), rest));
  }
  return out;
}

/** Plain text with the setup's pattern: a matching line starts an entry, the lines after it
 *  that don't match belong to it */
function patternLines(raw, pattern) {
  let re = null;
  try {
    re = regex(pattern);
  } catch {}
  const out = [];
  for (const l of raw) {
    const m = re?.exec(l);
    if (m) {
      const g = (name) => m.groups?.[name] ?? "";
      out.push(plainEntry(g("time"), g("level") ? level(g("level")) : lineLevel(l), g("message")));
    } else if (out.length) addTo(out[out.length - 1], l);
    else out.push(plainEntry("", lineLevel(l), l));
  }
  return out;
}

export function parse(textIn, setup) {
  const s = complete(setup);
  const raw = textIn.split(/\r?\n/).filter((l) => l.trim());
  let json = false;
  if (raw.length && raw[0].trimStart().startsWith("{")) {
    try {
      JSON.parse(raw[0]);
      json = true;
    } catch {}
  }
  if (json) return raw.map((l) => jsonLine(l, s.fields));
  if (s.line_pattern) return patternLines(raw, s.line_pattern);
  return plainLines(raw);
}

// ------------------------------------------------------------ sections

const containsAny = (message, texts) => !!message && (texts ?? []).some((t) => t && message.includes(t));

/** All sections, in order of their first line (and of the setup for sections starting
 *  together). A line whose message contains a start text opens a section, which ends at the
 *  first later line whose message contains an end text (that line included), or runs to the
 *  end of the file. */
export function blocks(lines, configs) {
  const out = [];
  lines.forEach((line, i) => {
    for (const c of configs ?? []) {
      if (!containsAny(line.message, c.start)) continue;
      let last = null;
      for (let j = i + 1; j < lines.length; j++) {
        if (containsAny(lines[j].message, c.end)) {
          last = j;
          break;
        }
      }
      out.push({ kind: c.kind, name: title(line.message.trim(), c.alias ?? null), first_line: i, last_line: last });
    }
  });
  return out;
}

export function title(message, alias) {
  if (!alias) return message;
  switch (alias.type) {
    case "regex":
      try {
        const m = regex(alias.value, "s").exec(message);
        return m && m[1] !== undefined ? m[1].trim() : message;
      } catch {
        return message;
      }
    case "rewrite":
      return alias.value;
    case "replace":
      return message.split(alias.value.from).join(alias.value.to);
    case "prefix":
      return `${alias.value}${message}`;
    default:
      return message;
  }
}

// ------------------------------------------------------------ the outline

/** Lines and sections as a tree: bookmarks (◆) hold the indices (▸) inside them, and every line
 *  appears exactly once, in its innermost section */
export function outline(lines, all) {
  if (!lines.length) return [];
  const span = (b) => ({ block: b, end: b.last_line ?? lines.length - 1 });
  // Stable sorts: sections starting on the same line keep their order
  const bookmarks = all.filter((b) => b.kind === "bookmark").map(span).sort((a, b) => a.block.first_line - b.block.first_line);
  const indices = all.filter((b) => b.kind === "index").map(span).sort((a, b) => a.block.first_line - b.block.first_line);
  const contains = (outer, inner) => outer.block.first_line <= inner.block.first_line && inner.end <= outer.end;
  // Each index goes into the first bookmark that contains it, or stays at the top
  const childrenOf = bookmarks.map(() => []);
  const top = bookmarks.map((s, i) => [i, s]);
  for (const index of indices) {
    const i = bookmarks.findIndex((bm) => contains(bm, index));
    if (i >= 0) childrenOf[i].push(index);
    else top.push([null, index]);
  }
  top.sort((a, b) => a[1].block.first_line - b[1].block.first_line);

  /** Sibling sections with the lines between them, in order. Neighbouring sections often share
   *  one boundary line (a step's end is the next step's start); it's shown once, as the first
   *  line of the section that opens there. */
  const sequence = (cursor, endInclusive, list) => {
    const out = [];
    for (const [bookmark, s] of list) {
      const start = Math.max(s.block.first_line, cursor);
      if (s.end < start) continue; // used up by the boundary it shares with the one before
      for (let line = cursor; line < start; line++) out.push({ type: "line", line });
      out.push(block(bookmark, s, start));
      cursor = s.end + 1;
    }
    for (let line = cursor; line <= endInclusive; line++) out.push({ type: "line", line });
    return out;
  };

  const block = (bookmark, s, start) => {
    const nested = bookmark === null ? [] : [...childrenOf[bookmark]].sort((a, b) => a.block.first_line - b.block.first_line).map((c) => [null, c]);
    let hasError = false;
    for (let i = start; i <= s.end; i++) if (lines[i].level === "ERROR") (hasError = true);
    return {
      type: "block",
      kind: s.block.kind,
      name: s.block.name || (s.block.kind === "bookmark" ? "Bookmark" : "Index"),
      first_line: start,
      last_line: s.end,
      has_error: hasError,
      children: sequence(start, s.end, nested),
    };
  };

  return sequence(0, lines.length - 1, top);
}

// ------------------------------------------------------------ files

function read(path) {
  try {
    return readFileSync(path).toString("utf8");
  } catch (e) {
    throw new Error(`couldn't read ${path}: ${e.message}`);
  }
}

/** A log, ready to show */
export function open(path, setup) {
  const s = complete(setup);
  const bytes = readFileSync(path);
  const lines = parse(bytes.toString("utf8"), s);
  return { lines, outline: outline(lines, blocks(lines, s.blocks)), size: bytes.length };
}

/** Whether a file has an ERROR line, remembered until the file changes (the list is looked at
 *  every few seconds, and logs can be big) */
const errors = new Map();
function hasError(path, mtime, size, setup) {
  const seen = errors.get(path);
  if (seen && seen.mtime === mtime && seen.size === size) return seen.error;
  let error = false;
  try {
    error = parse(read(path), setup).some((l) => l.level === "ERROR");
  } catch {}
  errors.set(path, { mtime, size, error });
  return error;
}

/** Log files in the setup's folders, newest first; and the folders that don't exist */
export function list(project, setup) {
  const s = complete(setup);
  const files = [];
  const missing = [];
  for (const folder of s.folders.map((f) => f.trim()).filter(Boolean)) {
    const dir = resolve(project, folder);
    try {
      if (!statSync(dir).isDirectory()) throw new Error();
    } catch {
      missing.push(folder);
      continue;
    }
    for (const name of globSync(s.pattern, { cwd: dir })) {
      const path = resolve(dir, name);
      if (files.some((f) => f.path === path)) continue;
      let st;
      try {
        st = statSync(path);
      } catch {
        continue;
      }
      if (!st.isFile()) continue;
      const mtime = st.mtimeMs / 1000;
      files.push({ name: path.split("/").pop(), path, mtime, size: st.size, error: hasError(path, mtime, st.size, s) });
    }
  }
  files.sort((a, b) => b.mtime - a.mtime);
  return { files, missing };
}

/** "2026-07-31 10:00:00,001" (or with T, or .001) as seconds */
export function timestamp(t) {
  t = t.slice(0, 23);
  const num = (a, b) => (/^\d+$/.test(t.slice(a, b)) && t.length >= b ? Number(t.slice(a, b)) : null);
  const [y, mo, d, h, mi, s] = [num(0, 4), num(5, 7), num(8, 10), num(11, 13), num(14, 16), num(17, 19)];
  if ([y, mo, d, h, mi, s].some((v) => v === null)) return null;
  return Date.UTC(y, mo - 1, d, h, mi, s, num(20, 23) ?? 0) / 1000;
}

export function formatDuration(seconds) {
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  const secs = Math.floor(seconds) % 60;
  return minutes < 60 ? `${minutes}m ${secs}s` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/** At a glance, for the file list's preview */
export function summary(path, setup) {
  const log = open(path, setup);
  const levels = [["DEBUG", 0], ["INFO", 0], ["WARNING", 0], ["ERROR", 0]];
  for (const line of log.lines) {
    const found = levels.find(([l]) => l === line.level);
    if (found) found[1] += 1;
    else levels.push([line.level, 1]);
  }
  const [a, b] = [log.lines[0], log.lines.at(-1)].map((l) => (l ? timestamp(l.time) : null));
  return {
    total: log.lines.length,
    levels,
    blocks: log.outline.filter((n) => n.type === "block").length,
    first_error: log.lines.find((l) => l.level === "ERROR")?.message ?? null,
    duration: a !== null && b !== null && b >= a ? formatDuration(b - a) : null,
  };
}
