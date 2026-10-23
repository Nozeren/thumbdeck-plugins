// Reading git's output for the Git tab: pure functions, tested with `node --test` (git.test.js).

/** Diffs longer than this are cut (a huge generated file would freeze the page) */
export const MAX_DIFF = 300_000;

/** "## main...origin/main [ahead 2, behind 1]" and friends */
export function parseBranch(line) {
  const b = { name: null, upstream: null, ahead: 0, behind: 0, gone: false };
  line = line.replace(/^## /, "");
  const fresh = /^(?:No commits yet on|Initial commit on) (.+)$/.exec(line);
  if (fresh) return { ...b, name: fresh[1] };
  if (line.startsWith("HEAD (no branch)")) return b;
  const [names, track = ""] = line.split(" [");
  const [name, upstream] = names.split("...");
  b.name = name;
  b.upstream = upstream ?? null;
  for (const part of track.replace(/\]$/, "").split(", ")) {
    const [word, n] = part.split(" ");
    if (word === "ahead") b.ahead = Number(n) || 0;
    else if (word === "behind") b.behind = Number(n) || 0;
    else if (part === "gone") b.gone = true;
  }
  return b;
}

/** `git status --porcelain=v1 -b -z`: the branch line, then "XY path" entries (a rename's
 *  entry is followed by the path it came from) */
export function parseStatus(out) {
  const entries = out.split("\0").filter(Boolean);
  let branch = parseBranch("## HEAD (no branch)");
  const changes = [];
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (e.startsWith("## ")) {
      branch = parseBranch(e);
      continue;
    }
    const [x, y] = [e[0], e[1]];
    if (x === undefined || y === undefined) continue;
    const path = e.slice(3);
    const from = x === "R" || x === "C" ? (entries[++i] ?? null) : null;
    // Conflicts show as U in either column, or AA / DD
    const conflict = x === "U" || y === "U" || (x === y && (x === "A" || x === "D"));
    changes.push({ path, from, staged: conflict ? "U" : x, unstaged: conflict ? "U" : y });
  }
  return { branch, changes };
}

/** Records split with the unit (\x1f) and record (\x1e) separators: they can't be in a message */
export function records(out, fields) {
  return out
    .split("\x1e")
    .map((r) => r.replace(/^\n+/, ""))
    .filter(Boolean)
    .map((r) => r.split("\x1f"))
    .filter((f) => f.length === fields);
}

export const LOG_FORMAT = "--format=%H%x1f%h%x1f%an%x1f%aI%x1f%s%x1f%D%x1e";
export const parseLog = (out) =>
  records(out, 6).map(([hash, short, author, date, subject, refs]) => ({ hash, short, author, date, subject, refs }));

export const BRANCH_FORMAT =
  "--format=%(refname:short)%1f%(HEAD)%1f%(upstream:short)%1f%(upstream:track)%1f%(committerdate:iso-strict)%1f%(contents:subject)%1e";
export const parseBranches = (out) =>
  records(out, 6).map(([name, head, upstream, track, date, subject]) => ({
    name, current: head === "*", upstream: upstream || null, track, date, subject,
  }));

export const STASH_FORMAT = "--format=%gd%x1f%s%x1f%cI%x1e";
export const parseStashes = (out) => records(out, 3).map(([name, subject, date]) => ({ name, subject, date }));

/** Staged, then changed (conflicts first), then untracked */
export function groupChanges(changes) {
  const staged = changes.filter((c) => c.staged !== " " && c.staged !== "?" && c.staged !== "U");
  const changed = changes
    .filter((c) => c.unstaged !== " " && c.unstaged !== "?")
    .sort((a, b) => Number(b.unstaged === "U") - Number(a.unstaged === "U"));
  const untracked = changes.filter((c) => c.unstaged === "?");
  return [
    ...staged.map((change) => ({ group: "staged", change, state: change.staged })),
    ...changed.map((change) => ({ group: "changes", change, state: change.unstaged })),
    ...untracked.map((change) => ({ group: "untracked", change, state: "?" })),
  ];
}

export const stateWord = {
  M: "modified", A: "added", D: "deleted", R: "renamed", C: "copied", U: "conflict", T: "type changed", "?": "new",
};

/** How to colour a line of a diff (or of `git show`: the message lines are plain text) */
export function lineKind(line) {
  if (/^(diff |index |--- |\+\+\+ |new file|deleted file|similarity|rename |old mode|new mode|Binary files)/.test(line)) return "meta";
  if (line.startsWith("@@")) return "hunk";
  if (line.startsWith("+")) return "add";
  if (line.startsWith("-")) return "del";
  return "text";
}

/** "↑2 ↓1", "" when even */
export const track = (ahead, behind) => [ahead ? `↑${ahead}` : "", behind ? `↓${behind}` : ""].filter(Boolean).join(" ");

/** Branch and tag names from git's %D ("HEAD -> main, origin/main, tag: v1") */
export const refNames = (refs) => refs.split(", ").map((r) => r.replace(/^HEAD -> /, "")).filter((r) => r && r !== "HEAD");

/** "5m ago" from an ISO time */
export function ago(iso, now = Date.now()) {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const s = Math.max(0, (now - t) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

/** A long diff, cut */
export const cut = (text) => (text.length > MAX_DIFF ? `${text.slice(0, MAX_DIFF)}\n… (cut: the diff is too long to show)` : text);

/** `git diff --numstat` (or `git show --numstat`): path -> [added, removed] (null for a binary file) */
export function parseNumstat(out) {
  const map = new Map();
  for (const line of out.split("\n")) {
    const m = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line);
    if (!m) continue;
    // A rename is written "old => new" or "dir/{old => new}/file": keep the new path
    const path = m[3].replace(/\{[^{}]* => ([^{}]*)\}/g, "$1").replace(/^.* => /, "").replace(/\/\//g, "/");
    map.set(path, m[1] === "-" ? null : [Number(m[1]), Number(m[2])]);
  }
  return map;
}

/** " 3 files changed, 10 insertions(+), 2 deletions(-)" as { files, added, removed } */
export function parseShortstat(text) {
  const n = (re) => Number(re.exec(text)?.[1] ?? 0);
  return { files: n(/(\d+) files? changed/), added: n(/(\d+) insertions?\(\+\)/), removed: n(/(\d+) deletions?\(-\)/) };
}

/** `git log` with LOG_FORMAT and --shortstat: the commits, each with its counts (git writes a
 *  commit's stat after its line, so it sits at the start of the next record) */
export const LOG_STAT_ARGS = [LOG_FORMAT, "--shortstat"];
export function parseLogStat(out) {
  const chunks = out.split("\x1e");
  const commits = [];
  chunks.forEach((chunk, i) => {
    const at = chunk.search(/[0-9a-f]{40}\x1f/);
    const stat = at < 0 ? chunk : chunk.slice(0, at);
    if (i > 0 && commits.length) commits[commits.length - 1].stat = parseShortstat(stat);
    if (at < 0) return;
    const [hash, short, author, date, subject, refs] = chunk.slice(at).split("\x1f");
    commits.push({ hash, short, author, date, subject, refs: (refs ?? "").trim(), stat: { files: 0, added: 0, removed: 0 } });
  });
  return commits;
}

/** A diff as lines to draw: hunks, added, removed and unchanged lines with their numbers; git's
 *  header lines (diff --git, index, ---, +++) left out, the file names kept as "file" lines */
export function diffLines(text) {
  const out = [];
  let oldN = 0, newN = 0;
  for (const line of text.split("\n")) {
    if (line.startsWith("diff --git ")) {
      const m = / b\/(.+)$/.exec(line);
      out.push({ kind: "file", text: m ? m[1] : line.slice(11) });
      continue;
    }
    if (/^(index |--- |\+\+\+ |new file mode|deleted file mode|similarity index|rename (from|to) |old mode|new mode)/.test(line)) continue;
    const h = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@ ?(.*)$/.exec(line);
    if (h) {
      oldN = Number(h[1]);
      newN = Number(h[2]);
      out.push({ kind: "hunk", text: h[3] ?? "" });
    } else if (line.startsWith("+")) out.push({ kind: "add", text: line.slice(1), old: null, new: newN++ });
    else if (line.startsWith("-")) out.push({ kind: "del", text: line.slice(1), old: oldN++, new: null });
    else if (line.startsWith(" ")) out.push({ kind: "same", text: line.slice(1), old: oldN++, new: newN++ });
    else if (line.startsWith("Binary files")) out.push({ kind: "meta", text: "A binary file: no text to show" });
    else if (line.startsWith("\\")) continue;
    else if (line.trim()) out.push({ kind: "meta", text: line });
  }
  return out;
}

/** The repo's main branch among the local ones (main, master, trunk, develop), or null */
export const mainBranch = (names) => ["main", "master", "trunk", "develop"].find((n) => names.includes(n)) ?? null;

/** Picked commits as [newest, oldest] indexes in the list (newest first): from the commit picking
 *  started at to the cursor, either way; null when that commit isn't in the list */
export function pickRange(commits, anchor, cursor) {
  const a = anchor ? commits.findIndex((c) => c.hash === anchor) : -1;
  return a < 0 ? null : [Math.min(a, cursor), Math.max(a, cursor)];
}
