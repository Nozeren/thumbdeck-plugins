// The Files plugin's logic, without any I/O (tested in files.test.js): kinds of files, sorting,
// fuzzy matching, git status per entry, names for copies, and bulk renames.

const EXT = {
  code: "js mjs cjs ts tsx jsx py rb go rs java kt c h cpp hpp cs php swift lua sh bash zsh fish vim sql html css scss vue svelte json jsonc yaml yml toml ini conf cfg xml gradle tf dockerfile makefile env gitignore editorconfig",
  md: "md markdown txt rst log",
  image: "png jpg jpeg gif webp bmp ico svg avif",
  video: "mp4 mkv webm mov avi m4v",
  audio: "mp3 wav flac ogg m4a opus",
  pdf: "pdf",
  csv: "csv tsv",
  zip: "zip tar gz tgz xz bz2 zst 7z rar jar",
};
const KIND = new Map(Object.entries(EXT).flatMap(([k, list]) => list.split(" ").map((e) => [e, k])));

/** What a file is, from its name: code, md, image, video, audio, pdf, csv, zip or file */
export function kindOf(name) {
  const lower = name.toLowerCase();
  if (["dockerfile", "makefile", "justfile", ".env", ".gitignore", ".bashrc", ".zshrc"].includes(lower) || lower.startsWith(".env.")) return "code";
  if (/\.tar\.(gz|xz|bz2|zst)$/.test(lower)) return "zip";
  const ext = lower.includes(".") ? lower.split(".").pop() : "";
  return KIND.get(ext) ?? "file";
}

/** Folders first, then by name (numbers in order), size (biggest first) or date (newest first) */
export function sortEntries(entries, by = "name") {
  const cmp = {
    name: (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }),
    size: (a, b) => b.size - a.size || a.name.localeCompare(b.name),
    date: (a, b) => b.mtime - a.mtime || a.name.localeCompare(b.name),
  }[by];
  return [...entries].sort((a, b) => (a.dir !== b.dir ? (a.dir ? -1 : 1) : cmp(a, b)));
}

/** Do the letters of q appear in s, in order? Returns the matched positions, or null */
export function fuzzy(q, s) {
  const at = [];
  let i = 0;
  const lower = s.toLowerCase();
  for (const ch of q.toLowerCase()) {
    i = lower.indexOf(ch, i);
    if (i < 0) return null;
    at.push(i++);
  }
  return at;
}

/** A score for ranking fuzzy matches: matches in the file name, together and early, rank first */
export function score(q, path) {
  const name = path.split("/").pop();
  const inName = fuzzy(q, name);
  const at = inName ?? fuzzy(q, path);
  if (!at) return -1;
  let s = inName ? 100 : 0;
  for (let i = 1; i < at.length; i++) if (at[i] === at[i - 1] + 1) s += 5;
  if (inName && name.toLowerCase().startsWith(q.toLowerCase())) s += 50;
  return s - at[0] * 0.5 - path.length * 0.05;
}

/**
 * `git status --porcelain=v1 -z` → { "path from the repo root": "M" | "A" | "D" | "R" | "U" | "I" }
 * (U: untracked, I: ignored; a rename is listed under its new name)
 */
export function parseGitStatus(out) {
  const status = {};
  const parts = out.split("\0");
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (p.length < 4) continue;
    const xy = p.slice(0, 2), path = p.slice(3);
    let code;
    if (xy === "??") code = "U";
    else if (xy === "!!") code = "I";
    else if (xy.includes("R")) { code = "R"; i++; } // the old name follows
    else if (xy.includes("A")) code = "A";
    else if (xy.includes("D")) code = "D";
    else code = "M";
    status[path.replace(/\/$/, "")] = code;
  }
  return status;
}

/**
 * The git state of each entry of a folder: its own, or "•" for a folder with changes inside
 * (rel: the folder's path from the repo root, "" at the root)
 */
export function statusFor(names, rel, status) {
  const out = {};
  const prefix = rel ? rel + "/" : "";
  for (const [path, code] of Object.entries(status)) {
    if (!path.startsWith(prefix)) {
      // An ignored folder holding this one
      if (code === "I" && (prefix.startsWith(path + "/"))) for (const n of names) out[n] = "I";
      continue;
    }
    const rest = path.slice(prefix.length);
    const top = rest.split("/")[0];
    if (!names.includes(top)) continue;
    if (rest === top) out[top] = code;
    else if (code !== "I" && out[top] !== "I") out[top] ??= "•";
    else if (code === "I") out[top] ??= "I";
  }
  return out;
}

/** "report.pdf" taken → "report (2).pdf" */
export function uniqueName(name, taken) {
  const has = new Set(taken);
  if (!has.has(name)) return name;
  const m = /^(.+?)((?:\.tar)?\.[^.]+)?$/.exec(name);
  const base = m[1], ext = m[2] ?? "";
  for (let i = 2; ; i++) if (!has.has(`${base} (${i})${ext}`)) return `${base} (${i})${ext}`;
}

/**
 * A bulk rename from the edited buffer: { changes: [[old, new]], problem }
 * The buffer holds one name per line, in the same order; nothing changes when it's wrong.
 */
export function bulkPlan(names, text, taken = []) {
  const lines = text.replace(/\n+$/, "").split("\n").map((l) => l.trim());
  if (lines.length !== names.length) return { changes: [], problem: `the buffer has ${lines.length} lines for ${names.length} names` };
  if (lines.some((l) => !l)) return { changes: [], problem: "a line is empty" };
  if (lines.some((l) => l.includes("/"))) return { changes: [], problem: "a name has a /" };
  const dupes = lines.filter((l, i) => lines.indexOf(l) !== i);
  if (dupes.length) return { changes: [], problem: `${dupes[0]} is there twice` };
  const changes = names.map((n, i) => [n, lines[i]]).filter(([a, b]) => a !== b);
  const others = new Set(taken.filter((t) => !names.includes(t)));
  const clash = changes.find(([, b]) => others.has(b));
  if (clash) return { changes: [], problem: `there's already a ${clash[1]} here` };
  return { changes, problem: "" };
}

export function human(b) {
  if (b < 1024) return `${b} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = b, u = -1;
  while (v >= 1024 && u < units.length - 1) (v /= 1024), u++;
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[u]}`;
}

export function ago(ms, now = Date.now()) {
  const s = Math.max(0, (now - ms) / 1000);
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  if (s < 86400 * 60) return `${Math.floor(s / 86400)}d`;
  if (s < 86400 * 730) return `${Math.floor(s / 86400 / 30)}mo`;
  return `${Math.floor(s / 86400 / 365)}y`;
}

/** A path for showing: the home folder as ~ */
export const tilde = (path, home) => (home && (path === home || path.startsWith(home + "/")) ? "~" + path.slice(home.length) : path);

/** A word for the shell, quoted when it needs it */
export const quote = (s) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);
